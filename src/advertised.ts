import type { IndexedTool } from './catalog.js';

/**
 * The Mode 2 advertised tool set: the tools whose schemas this gateway has actually
 * handed to the connected MCP client through `tools/list`.
 *
 * This exists because "the catalog knows about a tool" and "the model can call that
 * tool" are different facts. Over stdio the client builds the model's function list
 * from `tools/list` and nothing else; a prose acknowledgement saying a tool was added
 * cannot register a function definition. So `request_tools` has to grow this set and
 * fire `notifications/tools/list_changed`, or the tool it just found stays uncallable.
 *
 * The set starts empty on purpose. It grows only by what the model actually asked for,
 * plus the pinned floor, which is what keeps the advertised surface small.
 */

/** An MCP tool definition, shaped exactly as it goes over the wire in a tools/list result. */
export interface AdvertisedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

interface Entry {
  schema: AdvertisedTool;
  /** Pinned tools are the deterministic floor of the surface and are never evicted. */
  sticky: boolean;
  addedAt: number;
}

/**
 * Upper bound on how many discovered tools stay advertised at once.
 *
 * Bounded for the same reason CARRY_OVER_LIMIT is: an advertised set that only ever
 * grows converges on the full catalog, which silently turns Mode 2 back into the
 * dump-everything baseline it exists to avoid. Eviction is recency-ordered and costs
 * the model one extra `request_tools` round trip to get a dropped tool back.
 */
export const ADVERTISED_LIMIT = 24;

const advertised = new Map<string, Entry>();

function toAdvertisedTool(tool: IndexedTool): AdvertisedTool | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(tool.full_schema_json);
  } catch {
    console.error(`[Advertised] Skipped ${tool.tool_name}: stored schema is not valid JSON.`);
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;

  // The catalog stores the upstream tool object verbatim, so name/description/annotations
  // come along for free. inputSchema is the one field MCP requires, and an upstream that
  // omitted it would otherwise produce a tools/list entry the client rejects.
  return {
    ...parsed,
    name: tool.tool_name,
    description: parsed.description ?? tool.description,
    inputSchema: parsed.inputSchema ?? parsed.parameters ?? { type: 'object', properties: {} }
  };
}

function evictOverflow(): void {
  const evictable = [...advertised.entries()]
    .filter(([, entry]) => !entry.sticky)
    .sort((a, b) => a[1].addedAt - b[1].addedAt);

  let overflow = advertised.size - ADVERTISED_LIMIT;
  for (const [name] of evictable) {
    if (overflow <= 0) break;
    advertised.delete(name);
    overflow--;
  }
}

/**
 * Adds tools to the advertised set. Returns the names that were genuinely new, so the
 * caller can skip the list_changed notification when nothing actually changed.
 */
export function advertiseTools(tools: IndexedTool[], options: { sticky?: boolean } = {}): string[] {
  const sticky = options.sticky === true;
  const added: string[] = [];

  for (const tool of tools) {
    const schema = toAdvertisedTool(tool);
    if (!schema) continue;

    const existing = advertised.get(schema.name);
    if (existing) {
      // Re-requesting a tool the model already holds is evidence it is still in use,
      // so refresh the schema and the recency stamp rather than treating it as new.
      existing.schema = schema;
      existing.addedAt = Date.now();
      existing.sticky = existing.sticky || sticky;
      continue;
    }

    advertised.set(schema.name, { schema, sticky, addedAt: Date.now() });
    added.push(schema.name);
  }

  evictOverflow();
  return added.filter(name => advertised.has(name));
}

/**
 * The advertised schemas, pinned first and alphabetical, then discovered tools in the
 * order they were added. The stable head matters: clients and providers cache on a
 * prefix, and a set that reshuffles on every discovery invalidates that cache.
 */
export function advertisedSchemas(): AdvertisedTool[] {
  const entries = [...advertised.values()];
  const pinned = entries
    .filter(entry => entry.sticky)
    .sort((a, b) => a.schema.name.localeCompare(b.schema.name));
  const discovered = entries
    .filter(entry => !entry.sticky)
    .sort((a, b) => a.addedAt - b.addedAt);
  return [...pinned, ...discovered].map(entry => entry.schema);
}

/**
 * Whether this gateway has handed the client a schema for the tool and not yet evicted it.
 *
 * The hallucination gate consults this alongside the injection window. Over stdio we know
 * exactly what the client is holding, because we are the ones who told it, so an advertised
 * tool does not need the time-boxed guess that Mode 1 has to make.
 */
export function isToolAdvertised(toolName: string): boolean {
  return advertised.has(toolName);
}

export function advertisedCount(): number {
  return advertised.size;
}

/** Test seam. Nothing in the running gateway needs to empty the set. */
export function clearAdvertised(): void {
  advertised.clear();
}
