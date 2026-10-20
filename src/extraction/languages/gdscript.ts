import * as path from 'path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

// PrestonKnopp/tree-sitter-gdscript (ABI 14). Grammar provenance and the
// contributions this integration builds on are recorded in docs/grammars/.
const text = (node: SyntaxNode, ctx: ExtractorContext): string => getNodeText(node, ctx.source);

/** Only a complete literal is static: never search inside a nested expression. */
function stringValue(node: SyntaxNode | null | undefined, ctx: ExtractorContext): string | null {
  if (node?.type !== 'string') return null;
  const value = text(node, ctx);
  const match = /^(?:&)?(["'])([^\r\n\\]*?)\1$/.exec(value);
  return match?.[2] ?? null;
}

function addRef(ctx: ExtractorContext, node: SyntaxNode, name: string, kind: 'calls' | 'references' | 'imports' | 'extends' | 'instantiates'): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (fromNodeId && name) ctx.addUnresolvedReference({
    fromNodeId, referenceName: name, referenceKind: kind,
    line: node.startPosition.row + 1, column: node.startPosition.column,
  });
}

function visitChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of node.namedChildren) ctx.visitNode(child);
}

function baseName(node: SyntaxNode, ctx: ExtractorContext): string | null {
  const literal = node.namedChildren.find((c) => c.type === 'string');
  if (literal) return stringValue(literal, ctx);
  const type = node.namedChildren.find((c) => c.type === 'type');
  return type ? text(type, ctx) : null;
}

/** A static binding's type, or the exact script a preload/load names. */
function bindingType(node: SyntaxNode, ctx: ExtractorContext): string | null {
  const type = getChildByField(node, 'type');
  if (type?.type === 'type') return text(type, ctx);
  const value = getChildByField(node, 'value');
  if (value?.type === 'call' && value.namedChild(0)?.type === 'identifier' && /^(preload|load)$/.test(text(value.namedChild(0)!, ctx))) {
    return stringValue(getChildByField(value, 'arguments')?.namedChild(0), ctx);
  }
  if (value?.type === 'attribute') {
    const children = value.namedChildren;
    if (children.length === 2 && children[0]?.type === 'identifier' &&
        children[1]?.type === 'attribute_call' && children[1].namedChild(0)?.text === 'new') {
      return text(children[0], ctx);
    }
  }
  return null;
}

/** Keep receiver evidence rather than reducing every object call to a bare name. */
function receiverName(receiver: SyntaxNode, at: SyntaxNode, ctx: ExtractorContext): string | null {
  if (receiver.type !== 'identifier') return null;
  const name = text(receiver, ctx);
  if (name === 'self' || name === 'super') return name;
  // Parameters and preceding locals shadow class members. Stop at a class;
  // never borrow a binding from a sibling method or inner class.
  let scope: SyntaxNode | null = at.parent;
  while (scope) {
    if (scope.type === 'for_statement' && getChildByField(scope, 'left')?.text === name) {
      const explicit = getChildByField(scope, 'type');
      if (explicit) return text(explicit, ctx);
      const collection = getChildByField(scope, 'right');
      if (collection?.type === 'identifier') {
        const type = receiverName(collection, scope, ctx);
        return type ? /^Array\[(.+)\]$/.exec(type)?.[1] ?? null : null;
      }
      return null;
    }
    if (scope.type === 'function_definition' || scope.type === 'lambda') {
      const params = getChildByField(scope, 'parameters');
      for (const param of params?.namedChildren ?? []) {
        const id = param.type === 'identifier' ? param : param.namedChildren.find((c) => c.type === 'identifier');
        if (id && text(id, ctx) === name) return bindingType(param, ctx);
      }
    }
    if (scope.type === 'body' || scope.type === 'class_body' || scope.type === 'source') {
      for (const child of [...scope.namedChildren].reverse()) {
        if (scope.type === 'body' && child.startIndex >= at.startIndex) continue;
        if ((child.type === 'variable_statement' || child.type === 'const_statement') &&
            getChildByField(child, 'name')?.text === name) return bindingType(child, ctx);
      }
    }
    if (scope.type === 'class_definition') break;
    scope = scope.parent;
  }
  return name; // a globally registered class, or an unresolved dynamic receiver
}

/** Shared by declaration and function-body walkers. The caller walks children. */
function expression(node: SyntaxNode, ctx: ExtractorContext): boolean {
  // Preserve the scene-node references supplied by the existing Godot PR.
  if (node.type === 'get_node') {
    const name = text(node, ctx).trim().replace(/^[%$]+/, '').replace(/"([^"]*)"/g, '$1');
    if (name) addRef(ctx, node, `godot-node:${name.replace(/^\.?\/*/, '').replace(/\//g, '::')}`, 'references');
    return true;
  }
  if (node.type === 'call') {
    const callee = node.namedChild(0);
    if (callee?.type !== 'identifier') return true;
    const name = text(callee, ctx);
    const arg = getChildByField(node, 'arguments')?.namedChild(0);
    if (name === 'preload' || name === 'load') {
      const file = stringValue(arg, ctx);
      if (file) {
        ctx.createNode('import', file, node, { signature: text(node, ctx) });
        addRef(ctx, node, file, 'imports');
        const fileNode = ctx.nodes.find((n) => n.kind === 'file');
        if (fileNode && fileNode.id !== ctx.nodeStack[ctx.nodeStack.length - 1]) {
          ctx.addUnresolvedReference({ fromNodeId: fileNode.id, referenceName: file, referenceKind: 'imports',
            line: node.startPosition.row + 1, column: node.startPosition.column });
        }
      }
    } else if (name === 'get_node' || name === 'get_node_or_null' || name === 'has_node') {
      const nodePath = stringValue(arg, ctx);
      if (nodePath) addRef(ctx, node, `godot-node:${nodePath.replace(/^\.?\/*/, '').replace(/\//g, '::')}`, 'references');
    } else if (name === 'emit_signal' || name === 'connect') {
      const signal = stringValue(arg, ctx);
      if (signal) addRef(ctx, node, signal, 'references');
    } else if (name === 'super') {
      const owner = ctx.nodes.find((n) => n.id === ctx.nodeStack[ctx.nodeStack.length - 1]);
      if (owner?.kind === 'method') addRef(ctx, node, `super.${owner.name}`, 'calls');
    } else {
      addRef(ctx, node, name, 'calls');
    }
    return true;
  }
  if (node.type === 'attribute') {
    const children = node.namedChildren;
    for (let i = 1; i < children.length; i++) {
      const call = children[i]!;
      if (call.type !== 'attribute_call') continue;
      const method = call.namedChild(0);
      if (method?.type !== 'identifier') continue;
      const name = text(method, ctx);
      // A call on a call's result has no statically known receiver here.
      const receiver = children[0]!;
      const owner = receiverName(receiver, node, ctx);
      if (!owner) continue;
      // Godot 4's named RPC callable executes that method on remote peers.
      // Keep its actual method name; an unknown callable resolves to nothing.
      if ((name === 'rpc' || name === 'rpc_id') && i <= 2) {
        const callable = i === 1 ? text(receiver, ctx) : `${owner}.${text(children[1]!, ctx)}`;
        addRef(ctx, call, callable, 'calls');
        continue;
      }
      const signalArgument = stringValue(getChildByField(call, 'arguments')?.namedChild(0), ctx);
      if (i === 1 && (name === 'emit_signal' || name === 'connect') && signalArgument) {
        addRef(ctx, call, owner === 'self' ? signalArgument : `${owner}.${signalArgument}`, 'references');
      } else if ((name === 'emit' || name === 'connect') && i <= 2) {
        const signal = i === 1 ? owner : `${owner}.${text(children[1]!, ctx)}`;
        addRef(ctx, call, signal, 'references');
      } else if (i === 1) {
        if (name === 'new') addRef(ctx, call, owner, 'instantiates');
        else addRef(ctx, call, `${owner}.${name}`, 'calls');
      }
    }
    return true;
  }
  return false;
}

export const gdscriptExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  methodTypes: ['function_definition'],
  classTypes: ['class_definition'],
  interfaceTypes: [], structTypes: [], enumTypes: [], typeAliasTypes: [],
  importTypes: [], callTypes: [], variableTypes: [],
  nameField: 'name', bodyField: 'body', paramsField: 'parameters', returnField: 'return_type',
  docstringStepOverTypes: ['annotation'],
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const result = getChildByField(node, 'return_type');
    return params ? getNodeText(params, source) + (result ? ` -> ${getNodeText(result, source)}` : '') : undefined;
  },
  isStatic: (node) => node.namedChildren.some((c) => c.type === 'static_keyword'),
  visitNode: (node, ctx) => {
    if (node.type === 'source') {
      // A .gd file IS a class; class_name only registers its global name.
      // Its declaration and extends are siblings of its methods in this AST.
      const declaration = node.namedChildren.find((c) => c.type === 'class_name_statement');
      const name = declaration && getChildByField(declaration, 'name');
      const cls = ctx.createNode('class', name ? text(name, ctx) : path.posix.basename(ctx.filePath, path.posix.extname(ctx.filePath)), node, {
        isExported: !!name,
        signature: (node.namedChildren.find((c) => c.type === 'extends_statement') ?? declaration?.namedChildren.find((c) => c.type === 'extends_statement'))?.text,
      });
      if (cls) ctx.pushScope(cls.id);
      visitChildren(node, ctx);
      if (cls) ctx.popScope();
      return true;
    }
    if (node.type === 'class_definition') {
      const name = getChildByField(node, 'name');
      const body = getChildByField(node, 'body');
      const base = getChildByField(node, 'extends');
      if (name) {
        const cls = ctx.createNode('class', text(name, ctx), node, { signature: base?.text });
        if (cls) ctx.pushScope(cls.id);
        if (base) ctx.visitNode(base);
        if (body) visitChildren(body, ctx);
        if (cls) ctx.popScope();
      }
      return true;
    }
    if (node.type === 'class_name_statement') {
      visitChildren(node, ctx); // Godot 3 permits `class_name Player extends Node`.
      return true;
    }
    if (node.type === 'extends_statement') {
      const base = baseName(node, ctx);
      if (base) addRef(ctx, node, base, 'extends');
      return true;
    }
    if (node.type === 'signal_statement' || node.type === 'variable_statement' || node.type === 'const_statement') {
      const name = getChildByField(node, 'name');
      const accessors = getChildByField(node, 'setget');
      const member = name && ctx.createNode(accessors ? 'property' : node.type === 'const_statement' ? 'constant' : 'field', text(name, ctx), node, {
        signature: text(node, ctx).split(/\r?\n/)[0],
        ...(node.type === 'signal_statement' ? { decorators: ['signal'] } : {}),
      });
      // Initializer calls belong to the enclosing class, and use the body
      // walker so nested lambdas keep the normal function boundary behavior.
      const value = getChildByField(node, 'value');
      if (value) ctx.walkInitializer(value);
      if (accessors && member) {
        ctx.pushScope(member.id);
        ctx.visitFunctionBody(accessors, member.id);
        ctx.popScope();
      }
      return true;
    }
    if (node.type === 'enum_definition') {
      const name = getChildByField(node, 'name');
      const en = name ? ctx.createNode('enum', text(name, ctx), node) : null;
      if (en) ctx.pushScope(en.id);
      const body = getChildByField(node, 'body');
      for (const member of body?.namedChildren ?? []) {
        const id = getChildByField(member, 'left');
        if (id) ctx.createNode('enum_member', text(id, ctx), member, { signature: text(member, ctx) });
      }
      if (en) ctx.popScope();
      return true;
    }
    if (expression(node, ctx)) {
      visitChildren(node, ctx);
      return true;
    }
    return false;
  },
  visitBodyNode: expression,
};
