/** Join statically resolved signal emissions and subscriptions by declaration ID. */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Edge } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { MaybeYield } from './cooperative-yield';
import type { ResolutionContext } from './types';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { matchGdscriptReference } from './gdscript';

function literal(node: SyntaxNode | null | undefined): string | null {
  if (node?.type !== 'string') return null;
  return /^(?:&)?(["'])([^\r\n\\]*?)\1$/.exec(node.text)?.[2] ?? null;
}

function callback(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'attribute') {
    const parts = node.namedChildren;
    if (parts.length === 2 && parts[0]?.text === 'self' && parts[1]?.type === 'identifier') return `self.${parts[1].text}`;
    // A bound callback still invokes the same function.
    const last = parts[parts.length - 1];
    if (last?.type === 'attribute_call' && last.namedChild(0)?.text === 'bind') {
      if (parts.length === 2 && parts[0]?.type === 'identifier') return parts[0].text;
      if (parts.length === 3 && parts[0]?.text === 'self' && parts[1]?.type === 'identifier') return `self.${parts[1].text}`;
    }
  }
  if (node.type === 'call' && node.namedChild(0)?.text === 'Callable') {
    const args = node.childForFieldName('arguments');
    if (args?.namedChild(0)?.text === 'self') return literal(args.namedChild(1));
  }
  return null;
}

export async function gdscriptSignalEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  await loadGrammarsForLanguages(['gdscript']);
  const parser = getParser('gdscript');
  if (!parser) return [];
  const signals = ctx.iterateNodesByKind?.('field') ?? ctx.getNodesByKind('field');
  // Read only files that actually reference a declared signal. Engine signals
  // and dynamic/untyped receivers never passed the exact GDScript matcher.
  const byFile = new Map<string, Edge[]>();
  let scanned = 0;
  for (const signal of signals) {
    if ((++scanned & 63) === 0) await onYield();
    if (signal.language !== 'gdscript' || !signal.decorators?.includes('signal')) continue;
    for (const edge of queries.getIncomingEdges(signal.id, ['references'])) {
      const caller = ctx.getNodeById?.(edge.source);
      if (caller?.language !== 'gdscript') continue;
      const edges = byFile.get(caller.filePath) ?? [];
      edges.push(edge);
      byFile.set(caller.filePath, edges);
    }
    await onYield();
  }
  const emits = new Map<string, Edge[]>();
  const subscriptions = new Map<string, Array<{ handler: string; site: string }>>();
  for (const [file, edges] of byFile) {
    await onYield();
    const source = ctx.readFile(file);
    if (source === null) continue;
    const tree = parser.parse(source);
    if (!tree) continue;
    try {
      const at = new Map<string, Edge[]>();
      for (const edge of edges) {
        const key = `${edge.line}:${edge.column}`;
        const bucket = at.get(key) ?? [];
        bucket.push(edge); at.set(key, bucket);
      }
      const walk = (node: SyntaxNode): void => {
        const refs = at.get(`${node.startPosition.row + 1}:${node.startPosition.column}`);
        if (refs && (node.type === 'call' || node.type === 'attribute_call')) {
          const method = node.namedChild(0)?.text;
          const args = node.childForFieldName('arguments');
          for (const ref of refs) {
            if (method === 'emit' || method === 'emit_signal') {
              const bucket = emits.get(ref.target) ?? [];
              bucket.push(ref); emits.set(ref.target, bucket);
            } else if (method === 'connect') {
              const arg = literal(args?.namedChild(0)) !== null ? 1 : 0;
              let handler = callback(args?.namedChild(arg));
              // Godot 3: connect("signal", self, "handler").
              if (!handler && arg === 1 && args?.namedChild(1)?.text === 'self') handler = literal(args.namedChild(2));
              if (!handler) continue;
              const resolved = matchGdscriptReference({
                fromNodeId: ref.source, referenceName: handler, referenceKind: 'function_ref',
                filePath: file, language: 'gdscript', line: ref.line!, column: ref.column ?? 0,
              }, ctx);
              if (resolved) {
                const bucket = subscriptions.get(ref.target) ?? [];
                bucket.push({ handler: resolved.targetNodeId, site: `${file}:${ref.line}` });
                subscriptions.set(ref.target, bucket);
              }
            }
          }
        }
        for (const child of node.namedChildren) walk(child);
      };
      walk(tree.rootNode);
    } finally { tree.delete(); }
  }
  const result: Edge[] = [];
  const seen = new Set<string>();
  for (const [signal, registrations] of subscriptions) {
    if (new Set(registrations.map((r) => r.handler)).size > 6) continue;
    for (const emit of emits.get(signal) ?? []) for (const registration of registrations) {
      const key = `${emit.source}:${registration.handler}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        source: emit.source, target: registration.handler, kind: 'calls', provenance: 'heuristic',
        line: emit.line, column: emit.column,
        metadata: { synthesizedBy: 'gdscript-signal', event: ctx.getNodeById?.(signal)?.name,
          registeredAt: registration.site },
      });
    }
  }
  return result;
}
