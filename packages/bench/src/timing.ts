const NS_PER_MS = 1_000_000n;
const NS_PER_S = 1_000_000_000n;

export type PhaseRecord = {
  name: string;
  ns: bigint;
  notes?: string;
  children?: PhaseRecord[];
};

export class PhaseTimer {
  private records: PhaseRecord[] = [];

  async time<T>(
    name: string,
    fn: () => Promise<T>,
    opts?: { notes?: string; children?: PhaseRecord[] },
  ): Promise<T> {
    const start = Bun.nanoseconds();
    const result = await fn();
    const ns = BigInt(Bun.nanoseconds() - start);
    this.records.push({
      name,
      ns,
      notes: opts?.notes,
      children: opts?.children,
    });
    return result;
  }

  attach(name: string, ns: bigint, notes?: string, children?: PhaseRecord[]) {
    this.records.push({ name, ns, notes, children });
  }

  total(): bigint {
    return this.records.reduce((acc, r) => acc + r.ns, 0n);
  }

  all(): PhaseRecord[] {
    return this.records;
  }
}

export function formatDuration(ns: bigint): string {
  if (ns < NS_PER_MS) return `${ns}ns`;
  if (ns < NS_PER_S) return `${(Number(ns) / Number(NS_PER_MS)).toFixed(0)}ms`;
  return `${(Number(ns) / Number(NS_PER_S)).toFixed(2)}s`;
}

export function renderReport(records: PhaseRecord[]): string {
  const lines: string[] = [];
  const nameWidth = Math.max(
    20,
    ...records.flatMap((r) => [
      r.name.length,
      ...(r.children?.map((c) => c.name.length + 2) ?? []),
    ]),
  );
  lines.push(
    `${"phase".padEnd(nameWidth)}  duration   notes`,
  );
  lines.push("─".repeat(nameWidth + 22));

  for (const r of records) {
    lines.push(
      `${r.name.padEnd(nameWidth)}  ${formatDuration(r.ns).padEnd(9)}  ${r.notes ?? ""}`,
    );
    if (r.children) {
      for (const [i, child] of r.children.entries()) {
        const branch = i === r.children.length - 1 ? "└─" : "├─";
        const cname = `  ${branch} ${child.name}`;
        lines.push(
          `${cname.padEnd(nameWidth)}  ${formatDuration(child.ns).padEnd(9)}  ${child.notes ?? ""}`,
        );
      }
    }
  }
  return lines.join("\n");
}

export function recordsToJson(records: PhaseRecord[]): unknown {
  return records.map((r) => ({
    name: r.name,
    ns: r.ns.toString(),
    ms: Number(r.ns / NS_PER_MS),
    notes: r.notes,
    children: r.children ? recordsToJson(r.children) : undefined,
  }));
}
