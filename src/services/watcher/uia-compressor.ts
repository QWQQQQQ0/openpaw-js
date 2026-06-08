// UIA tree compression — strip runtime attributes, keep only role + name.
// Reduces token count by 90%+ for LLM region discovery.

interface UIANode {
  controlType?: string;
  ControlType?: string;
  role?: string;
  name?: string;
  Name?: string;
  children?: UIANode[];
  Children?: UIANode[];
  // Runtime attributes that will be stripped:
  // bounds, runtimeId, controlId, className, automationId, isOffscreen, etc.
}

interface CompressedNode {
  role: string;
  name: string;
  children: CompressedNode[];
}

/**
 * Compress a full UIA tree to role+name only.
 * Useful for both cache key generation and LLM prompts.
 */
export function compressUIATree(
  root: UIANode | UIANode[],
  maxDepth = 4,
  maxChildren = 20,
): CompressedNode[] {
  const nodes = Array.isArray(root) ? root : [root];
  const result: CompressedNode[] = [];
  for (const node of nodes.slice(0, maxChildren * 2)) {
    const c = compressSingle(node, 0, maxDepth, maxChildren);
    if (c) result.push(c);
  }
  return result;
}

function compressSingle(
  node: UIANode,
  depth: number,
  maxDepth: number,
  maxChildren: number,
): CompressedNode | null {
  if (depth > maxDepth) return null;

  const role = node.controlType ?? node.ControlType ?? node.role ?? 'unknown';
  const name = node.name ?? node.Name ?? '';

  const rawChildren = node.children ?? node.Children ?? [];
  const children: CompressedNode[] = [];
  if (depth < maxDepth) {
    for (const child of rawChildren.slice(0, maxChildren)) {
      const c = compressSingle(child, depth + 1, maxDepth, maxChildren);
      if (c) children.push(c);
    }
  }

  return { role, name, children };
}

/**
 * Generate a stable UIA signature string for cache keys.
 * Format: "role:name|role:name|..."
 */
export function uiaSignature(nodes: CompressedNode[]): string {
  const parts: string[] = [];
  flattenSignature(nodes, parts);
  return parts.join('|');
}

function flattenSignature(nodes: CompressedNode[], out: string[]): void {
  for (const n of nodes) {
    out.push(`${n.role}:${n.name}`);
    flattenSignature(n.children, out);
  }
}

/**
 * Convert compressed tree to a compact text representation for LLM prompts.
 */
export function uiaToText(nodes: CompressedNode[], indent = 0): string {
  let text = '';
  const prefix = '  '.repeat(indent);
  for (const n of nodes) {
    const label = n.name ? `${n.role} "${n.name}"` : n.role;
    text += `${prefix}- ${label}\n`;
    if (n.children.length > 0) {
      text += uiaToText(n.children, indent + 1);
    }
  }
  return text;
}
