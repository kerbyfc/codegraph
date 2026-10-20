/** GDScript uses exact script paths and class ownership, never global method-name guesses. */
import * as path from 'path';
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

function projectDir(fromFile: string, ctx: ResolutionContext): string {
  let dir = path.posix.dirname(fromFile);
  while (dir !== '.' && !ctx.fileExists(path.posix.join(dir, 'project.godot'))) dir = path.posix.dirname(dir);
  return dir;
}

export function gdscriptPath(specifier: string, fromFile: string, ctx: ResolutionContext): string | null {
  let target: string;
  if (specifier.startsWith('res://')) {
    // res:// is relative to the nearest Godot project, including in monorepos.
    const dir = projectDir(fromFile, ctx);
    const relative = path.posix.normalize(specifier.slice(6));
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) return null;
    target = path.posix.join(dir, relative);
  } else if (!specifier.includes('://') && !path.posix.isAbsolute(specifier)) {
    target = path.posix.join(path.posix.dirname(fromFile), specifier);
  } else return null;
  target = path.posix.normalize(target);
  if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) return null;
  return ctx.getNodesInFile(target).some((n) => n.kind === 'file') ? target : null;
}

function ownerOf(ref: UnresolvedRef, ctx: ResolutionContext): Node | undefined {
  const caller = ctx.getNodeById?.(ref.fromNodeId);
  return ctx.getNodesInFile(ref.filePath)
    .filter((n) => n.kind === 'class' && n.language === 'gdscript' &&
      (caller ? caller.id === n.id || caller.qualifiedName.startsWith(`${n.qualifiedName}::`)
        : n.startLine <= ref.line && n.endLine >= ref.line))
    .sort((a, b) => b.qualifiedName.length - a.qualifiedName.length)[0];
}

function scriptClass(file: string, ctx: ResolutionContext): Node | undefined {
  return ctx.getNodesInFile(file).filter((n) => n.kind === 'class' && n.language === 'gdscript')
    .sort((a, b) => a.qualifiedName.length - b.qualifiedName.length)[0];
}

function classNamed(name: string, ref: UnresolvedRef, ctx: ResolutionContext): Node | undefined {
  if (name.includes('/') || name.endsWith('.gd')) {
    const file = gdscriptPath(name, ref.filePath, ctx);
    return file ? scriptClass(file, ctx) : undefined;
  }
  const own = ownerOf(ref, ctx);
  // Inner classes are scoped, globally registered classes have isExported.
  if (own) {
    const inner = ctx.getNodesInFile(ref.filePath).find((n) => n.kind === 'class' && n.qualifiedName === `${own.qualifiedName}::${name}`);
    if (inner) return inner;
    if (own.name === name) return own;
    const binding = ctx.getNodesInFile(ref.filePath).find((n) =>
      (n.kind === 'constant' || n.kind === 'field') && n.qualifiedName === `${own.qualifiedName}::${name}`);
    const preload = binding?.signature && /(?:=|:=)\s*(?:preload|load)\(\s*(["'])([^"'\\]+)\1\s*\)\s*(?:#.*)?$/.exec(binding.signature);
    if (preload) {
      const file = gdscriptPath(preload[2]!, ref.filePath, ctx);
      return file ? scriptClass(file, ctx) : undefined;
    }
  }
  const config = ctx.readFile(path.posix.join(projectDir(ref.filePath, ctx), 'project.godot'));
  const autoloads = config && /^\[autoload\][ \t]*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(config)?.[1];
  if (autoloads) {
    for (const line of autoloads.split(/\r?\n/)) {
      const entry = /^([^=;]+)="\*(res:\/\/[^"\r\n]+\.gd)"[ \t]*$/.exec(line.trim());
      if (entry?.[1]?.trim() === name) {
        const file = gdscriptPath(entry[2]!, ref.filePath, ctx);
        return file ? scriptClass(file, ctx) : undefined;
      }
    }
  }
  const classes = ctx.getNodesByName(name).filter((n) => n.language === 'gdscript' && n.kind === 'class' && n.isExported &&
    projectDir(n.filePath, ctx) === projectDir(ref.filePath, ctx));
  return classes.length === 1 ? classes[0] : undefined;
}

function parentOf(cls: Node, ref: UnresolvedRef, ctx: ResolutionContext): Node | undefined {
  const written = cls.signature?.replace(/^extends\s+/, '').trim();
  if (!written) return undefined;
  const literal = /^(["'])(.*?)\1$/.exec(written);
  return classNamed(literal?.[2] ?? written, { ...ref, fromNodeId: cls.id, filePath: cls.filePath }, ctx);
}

function memberOf(cls: Node | undefined, name: string, ref: UnresolvedRef, ctx: ResolutionContext, seen = new Set<string>()): Node | undefined {
  if (!cls || seen.has(cls.id) || seen.size >= 32) return undefined;
  seen.add(cls.id);
  const members = ctx.getNodesInFile(cls.filePath).filter((n) => n.name === name && n.qualifiedName === `${cls.qualifiedName}::${name}` &&
    (ref.referenceKind === 'calls' || ref.referenceKind === 'function_ref'
      ? n.kind === 'method' || n.kind === 'function'
      : n.kind === 'field' && n.decorators?.includes('signal')));
  if (members.length === 1) return members[0];
  if (members.length > 1) return undefined;
  return memberOf(parentOf(cls, ref, ctx), name, ref, ctx, seen);
}

export function matchGdscriptReference(ref: UnresolvedRef, ctx: ResolutionContext): ResolvedRef | null {
  let target: Node | undefined;
  if (ref.referenceKind === 'imports') {
    const file = gdscriptPath(ref.referenceName, ref.filePath, ctx);
    target = file ? ctx.getNodesInFile(file).find((n) => n.kind === 'file') : undefined;
  } else if (ref.referenceKind === 'extends' || ref.referenceKind === 'instantiates') {
    target = classNamed(ref.referenceName, ref, ctx);
  } else if (ref.referenceKind === 'calls' || ref.referenceKind === 'references' || ref.referenceKind === 'function_ref') {
    const dot = ref.referenceName.lastIndexOf('.');
    const receiver = dot < 0 ? 'self' : ref.referenceName.slice(0, dot);
    const name = ref.referenceName.slice(dot + 1);
    const own = ownerOf(ref, ctx);
    const cls = receiver === 'self' ? own : receiver === 'super' ? own && parentOf(own, ref, ctx) : classNamed(receiver, ref, ctx);
    target = memberOf(cls, name, ref, ctx);
    // Parameter/return type dependencies can also name a global class.
    if (!target && ref.referenceKind === 'references' && dot < 0) target = classNamed(name, ref, ctx);
  }
  return target ? { original: ref, targetNodeId: target.id, confidence: 1, resolvedBy: 'exact-match' } : null;
}
