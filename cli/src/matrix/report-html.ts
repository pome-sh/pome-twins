// SPDX-License-Identifier: Apache-2.0
//
// Render a MatrixResult into a self-contained, English HTML dashboard
// (report.html). Founder-facing: clean, readable, no raw dump. House style is
// the status.pome.sh "trinity hybrid" (cream editorial canvas + dark
// product-chrome cards; Source Serif 4 / Inter / JetBrains Mono; colorblind-safe
// glyph+text). No CDN — every chart is plain HTML/CSS (div bars, a colored-table
// heatmap), so the file opens offline.
//
// Charts are deliberately framework-free: a div whose width is a percentage is
// a bar; a <td> whose background is a moss-luminance ramp (single hue, so it
// reads under any color vision) with the number printed inside is a heatmap.
//
// The format/escape helpers, the moss heat ramp, and the STYLES block are
// exported so the sibling eval-report view (eval-report-html.ts) shares one
// house style instead of forking it.
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MatrixResult, CellResult } from "./types.js";
import {
  UI,
  SCENARIO_COPY,
  SCAFFOLD_COPY,
  PROVIDER_BY_PREFIX,
  GITHUB_SCENARIO_BASE,
  type ScenarioCopy,
} from "./report-content.js";

// ---- small format/escape helpers ----

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
function fmtSat(x: number): string {
  return x.toFixed(x % 1 === 0 ? 0 : 1);
}
function fmtInt(x: number | null): string {
  return x === null ? "—" : Math.round(x).toLocaleString("en-US");
}
function fmtMs(x: number | null): string {
  if (x === null) return "—";
  return x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${Math.round(x)}ms`;
}
function fmtCost(x: number | null): string {
  if (x === null) return "—";
  return `$${x < 0.01 ? x.toFixed(5) : x.toFixed(4)}`;
}
function fmtConf(x: number | null): string {
  return x === null ? "—" : x.toFixed(2);
}

// ---- color: moss single-hue luminance ramp for the heatmap ----
// Single hue + luminance is colorblind-safe by construction; the printed number
// is the source of truth, the color is the at-a-glance gradient.
const RAMP_LO = [238, 243, 233]; // pale moss
const RAMP_HI = [47, 74, 36]; // deep moss
function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}
export function heatColor(sat: number): { bg: string; fg: string } {
  const t = Math.max(0, Math.min(1, sat / 100));
  const bg = `rgb(${lerp(RAMP_LO[0], RAMP_HI[0], t)}, ${lerp(RAMP_LO[1], RAMP_HI[1], t)}, ${lerp(RAMP_LO[2], RAMP_HI[2], t)})`;
  const fg = t > 0.52 ? "#faf9f5" : "#141413";
  return { bg, fg };
}

// ---- per-criterion aggregation (reads each run's score.json) ----

type CriterionAgg = {
  text: string;
  type: "D" | "P";
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
};
export type CriteriaByScenario = Map<string, CriterionAgg[]>;

type ScoreJson = {
  results?: {
    criterion?: { type?: string; text?: string };
    outcome?: "passed" | "failed" | "skipped" | "errored";
    passed?: boolean;
    skipped?: boolean;
  }[];
};

// Walk every cell's runs, read score.json from run_dir, and aggregate
// pass/fail/skip per (scenario, criterion text). Order-preserving by first
// sighting so the small-multiples read in scenario-criterion order.
export function buildCriteriaData(result: MatrixResult): CriteriaByScenario {
  const byScenario: CriteriaByScenario = new Map();
  for (const cell of result.cells) {
    let bucket = byScenario.get(cell.scenario);
    if (!bucket) {
      bucket = [];
      byScenario.set(cell.scenario, bucket);
    }
    for (const run of cell.runs) {
      const scorePath = join(run.run_dir, "score.json");
      if (!existsSync(scorePath)) continue;
      let score: ScoreJson;
      try {
        score = JSON.parse(readFileSync(scorePath, "utf8")) as ScoreJson;
      } catch {
        continue;
      }
      for (const r of score.results ?? []) {
        const text = r.criterion?.text;
        const type = r.criterion?.type === "P" ? "P" : "D";
        if (!text) continue;
        let agg = bucket.find((a) => a.text === text);
        if (!agg) {
          agg = { text, type, passed: 0, failed: 0, skipped: 0, errored: 0 };
          bucket.push(agg);
        }
        switch (criterionOutcome(r)) {
          case "passed":
            agg.passed += 1;
            break;
          case "failed":
            agg.failed += 1;
            break;
          case "errored":
            agg.errored += 1;
            break;
          default:
            agg.skipped += 1;
        }
      }
    }
  }
  return byScenario;
}

function criterionOutcome(
  result: NonNullable<ScoreJson["results"]>[number],
): "passed" | "failed" | "skipped" | "errored" {
  if (result.outcome) return result.outcome;
  if (result.skipped) return "skipped";
  return result.passed ? "passed" : "failed";
}

// ---- fleet model/provider lookup (agent_id → model slug, provider) ----

export type FleetModel = { model: string; provider: string };
export type FleetModels = Map<string, FleetModel>;

// Parse the agents YAML just enough to map agent id → model slug. Avoids a
// dependency on the full agentsConfig loader (which resolves prompts/files);
// the fleet files are flat enough that a tiny line scan is robust here.
export function buildFleetModels(agentsFile: string): FleetModels {
  const out: FleetModels = new Map();
  if (!agentsFile || !existsSync(agentsFile)) return out;
  let raw: string;
  try {
    raw = readFileSync(agentsFile, "utf8");
  } catch {
    return out;
  }
  let curId: string | null = null;
  for (const line of raw.split("\n")) {
    const idM = line.match(/^\s*-?\s*id:\s*(.+?)\s*$/);
    if (idM) {
      curId = idM[1].replace(/['"]/g, "");
      continue;
    }
    const modelM = line.match(/^\s*model:\s*(.+?)\s*$/);
    if (modelM && curId) {
      const model = modelM[1].replace(/['"]/g, "");
      const prefix = model.split("/")[0];
      out.set(curId, { model, provider: PROVIDER_BY_PREFIX[prefix] ?? prefix });
    }
  }
  return out;
}

// ---- per-agent resource rollups (mean tokens/latency across the agent's runs) ----

type AgentRollup = {
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
};
function buildAgentRollups(result: MatrixResult): Map<string, AgentRollup> {
  const out = new Map<string, AgentRollup>();
  const byAgent = new Map<string, CellResult[]>();
  for (const c of result.cells) {
    const arr = byAgent.get(c.agent_id) ?? [];
    arr.push(c);
    byAgent.set(c.agent_id, arr);
  }
  for (const [agent, cells] of byAgent) {
    const runs = cells.flatMap((c) => c.runs);
    out.set(agent, {
      promptTokens: meanNullable(runs.map((r) => r.prompt_tokens)),
      completionTokens: meanNullable(runs.map((r) => r.completion_tokens)),
      latencyMs: meanNullable(runs.map((r) => r.latency_ms)),
    });
  }
  return out;
}
function meanNullable(xs: (number | null)[]): number | null {
  const present = xs.filter((x): x is number => x !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

// ---- section renderers ----

function leaderboardSection(
  result: MatrixResult,
  fleet: FleetModels,
  rollups: Map<string, AgentRollup>,
  t: typeof UI,
): string {
  const rows = [...result.aggregate.leaderboard];
  const maxSat = Math.max(1, ...rows.map((r) => r.mean_satisfaction));
  const bars = rows
    .map((r, i) => {
      const w = (r.mean_satisfaction / maxSat) * 100;
      const model = fleet.get(r.agent_id)?.model ?? r.agent_id;
      return `
        <div class="lb-row">
          <div class="lb-rank num">${i + 1}</div>
          <div class="lb-name" title="${esc(model)}">${esc(shortAgent(r.agent_id))}</div>
          <div class="lb-track"><span class="lb-fill" style="width:${w.toFixed(1)}%"></span></div>
          <div class="lb-val num">${fmtSat(r.mean_satisfaction)}</div>
        </div>`;
    })
    .join("");

  const tableRows = rows
    .map((r) => {
      const roll = rollups.get(r.agent_id);
      const fm = fleet.get(r.agent_id);
      return `<tr>
        <td>${esc(shortAgent(r.agent_id))}</td>
        <td>${esc(fm?.provider ?? "")}</td>
        <td class="num">${fmtSat(r.mean_satisfaction)}</td>
        <td class="num">${pct(r.mean_pass_rate)}</td>
        <td class="num">${fmtInt(roll?.promptTokens ?? null)}</td>
        <td class="num">${fmtInt(roll?.completionTokens ?? null)}</td>
        <td class="num">${fmtMs(roll?.latencyMs ?? null)}</td>
        <td class="num">${fmtCost(r.total_cost_usd)}</td>
        <td class="num">${r.flaky_cells}</td>
      </tr>`;
    })
    .join("");

  return `
  <section class="card">
    <h2>${esc(t.secLeaderboard)}</h2>
    <p class="note">${esc(t.secLeaderboardNote)}</p>
    <div class="leaderboard">${bars}</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>${esc(t.thAgent)}</th><th>${esc(t.thProvider)}</th>
          <th class="num">${esc(t.thSatisfaction)}</th><th class="num">${esc(t.thPassRate)}</th>
          <th class="num">${esc(t.thTokensIn)}</th><th class="num">${esc(t.thTokensOut)}</th>
          <th class="num">${esc(t.thLatency)}</th><th class="num">${esc(t.thCost)}</th>
          <th class="num">${esc(t.thFlaky)}</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <p class="micro">${esc(t.costEstimated)}</p>
  </section>`;
}

function heatmapSection(
  result: MatrixResult,
  t: typeof UI,
): string {
  // Order rows by leaderboard rank, columns by scenario slug order.
  const agents = result.aggregate.leaderboard.map((l) => l.agent_id);
  const scenarios = [...result.config.scenario_slugs];
  const cellMap = new Map<string, CellResult>();
  for (const c of result.cells) cellMap.set(`${c.agent_id}::${c.scenario}`, c);

  const head = scenarios
    .map((s) => `<th class="hm-col" title="${esc(s)}">${esc(scenarioShort(s))}</th>`)
    .join("");
  const body = agents
    .map((agent) => {
      const tds = scenarios
        .map((s) => {
          const cell = cellMap.get(`${agent}::${s}`);
          if (!cell)
            return `<td class="hm hm-empty">${esc(t.noData)}</td>`;
          const { bg, fg } = heatColor(cell.mean_satisfaction);
          const flaky = cell.flaky ? " hm-flaky" : "";
          const flakyTip = cell.flaky ? ` · ${t.flakyMark}` : "";
          return `<td class="hm${flaky}" style="background:${bg};color:${fg}" title="${esc(agent)} · ${esc(s)}: ${cell.mean_satisfaction}${flakyTip}">${cell.mean_satisfaction}</td>`;
        })
        .join("");
      return `<tr><th class="hm-rowhead">${esc(shortAgent(agent))}</th>${tds}</tr>`;
    })
    .join("");

  return `
  <section class="card">
    <h2>${esc(t.secHeatmap)}</h2>
    <p class="note">${esc(t.secHeatmapNote)}</p>
    <div class="table-wrap">
      <table class="heatmap">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="hm-legend">
      <span>0</span>
      <span class="hm-grad"></span>
      <span>100</span>
      <span class="hm-flaky-key"><i></i> ${esc(t.flakyMark)}</span>
    </div>
  </section>`;
}

function discriminationSection(
  result: MatrixResult,
  t: typeof UI,
): string {
  const rows = [...result.aggregate.scenario_discrimination].sort(
    (a, b) => b.pass_variance - a.pass_variance,
  );
  const maxVar = Math.max(0.0001, ...rows.map((r) => r.pass_variance));
  const bars = rows
    .map((r) => {
      const w = (r.pass_variance / maxVar) * 100;
      const cls = r.low_signal ? "disc-low" : "disc-hi";
      const label = r.low_signal ? t.signalLowSignal : t.signalDiscriminating;
      return `
        <div class="disc-row">
          <div class="disc-name">${esc(scenarioShort(r.scenario))}</div>
          <div class="disc-track"><span class="disc-fill ${cls}" style="width:${w.toFixed(1)}%"></span></div>
          <div class="disc-meta"><span class="num">${r.pass_variance.toFixed(3)}</span> <span class="tag ${cls}">${esc(label)}</span></div>
        </div>`;
    })
    .join("");
  return `
  <section class="card">
    <h2>${esc(t.secDiscrimination)}</h2>
    <p class="note">${esc(t.secDiscriminationNote)}</p>
    <div class="discrimination">${bars}</div>
  </section>`;
}

function criteriaSection(
  criteria: CriteriaByScenario,
  result: MatrixResult,
  t: typeof UI,
): string {
  const scenarios = result.config.scenario_slugs;
  const cards = scenarios
    .map((s) => {
      const aggs = criteria.get(s) ?? [];
      if (aggs.length === 0) return "";
      const rows = aggs
        .map((a) => {
          const total = a.passed + a.failed;
          const rate = total === 0 ? 0 : a.passed / total;
          const w = rate * 100;
          let cls = "crit-mid";
          let glyph = "◐";
          let val = pct(rate);
          if (total === 0) {
            cls = "crit-uneval";
            glyph = a.errored > 0 ? "!" : "-";
            val = "UNEVAL";
          } else if (rate >= 0.999) {
            cls = "crit-ok";
            glyph = "✓";
          } else if (a.passed === 0) {
            cls = "crit-bad";
            glyph = "✗";
          }
          const kind = a.type === "P" ? t.kindJudge : t.kindDeterministic;
          const excluded = [
            a.skipped > 0 ? `${a.skipped} skipped` : "",
            a.errored > 0 ? `${a.errored} errored` : "",
          ].filter(Boolean).join(", ");
          return `
            <div class="crit-row">
              <div class="crit-text"><span class="crit-glyph ${cls}">${glyph}</span>${esc(a.text)} <span class="crit-kind">[${a.type}] ${esc(kind)}${excluded ? `; ${esc(excluded)}` : ""}</span></div>
              <div class="crit-track"><span class="crit-fill ${cls}" style="width:${w.toFixed(0)}%"></span></div>
              <div class="crit-val num">${val}</div>
            </div>`;
        })
        .join("");
      return `
        <div class="crit-card">
          <h3>${esc(scenarioShort(s))}</h3>
          <div class="crit-rows">${rows}</div>
        </div>`;
    })
    .filter(Boolean)
    .join("");
  return `
  <section class="card">
    <h2>${esc(t.secCriteria)}</h2>
    <p class="note">${esc(t.secCriteriaNote)}</p>
    <div class="crit-grid">${cards}</div>
  </section>`;
}

function scenariosSection(
  result: MatrixResult,
  t: typeof UI,
): string {
  const cards = result.config.scenario_slugs
    .map((s) => {
      const c: ScenarioCopy | undefined = SCENARIO_COPY[s];
      if (!c) return "";
      const roleLabel = t.roleLabel[c.role] ?? c.role;
      const link = `${GITHUB_SCENARIO_BASE}/${s}.md`;
      return `
        <article class="scn">
          <div class="scn-head">
            <span class="scn-slug num">${esc(s)}</span>
            <span class="tag role-${c.role}">${esc(roleLabel)}</span>
          </div>
          <h3>${esc(c.title)}</h3>
          <p><span class="scn-lbl">${esc(t.labelWhat)}</span> ${esc(c.what)}</p>
          <p><span class="scn-lbl">${esc(t.labelTests)}</span> ${esc(c.tests)}</p>
          <p><span class="scn-lbl">${esc(t.labelWhy)}</span> ${esc(c.why)}</p>
          <a class="scn-link" href="${esc(link)}" target="_blank" rel="noopener">${esc(t.openScenario)}</a>
        </article>`;
    })
    .filter(Boolean)
    .join("");
  return `
  <section class="card">
    <h2>${esc(t.secScenarios)}</h2>
    <p class="note">${esc(t.secScenariosNote)}</p>
    <div class="scn-grid">${cards}</div>
  </section>`;
}

function whatWeTestedSection(
  result: MatrixResult,
  fleet: FleetModels,
  judgeModel: string | null,
  t: typeof UI,
): string {
  const scaffoldRows = SCAFFOLD_COPY.map(
    (sc) => `<tr${sc.used ? ' class="row-used"' : ""}>
      <td><code>${esc(sc.name)}</code>${sc.used ? ' <span class="tag role-baseline">✓</span>' : ""}</td>
      <td>${esc(sc.basis)}</td>
      <td>${esc(sc.note)}</td>
    </tr>`,
  ).join("");

  const modelRows = result.aggregate.leaderboard
    .map((l) => {
      const fm = fleet.get(l.agent_id);
      return `<tr>
        <td><code>${esc(fm?.model ?? l.agent_id)}</code></td>
        <td>${esc(fm?.provider ?? "")}</td>
      </tr>`;
    })
    .join("");

  return `
  <section class="card">
    <h2>${esc(t.secWhat)}</h2>
    <p class="note">${esc(t.secWhatNote)}</p>

    <h3>${esc(t.thScaffold)}</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>${esc(t.thScaffold)}</th><th>${esc(t.thBasis)}</th><th></th></tr></thead>
      <tbody>${scaffoldRows}</tbody>
    </table></div>

    <h3>${esc(t.thModel)} · ${result.config.agent_ids.length}</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>${esc(t.thModel)}</th><th>${esc(t.thProvider)}</th></tr></thead>
      <tbody>${modelRows}</tbody>
    </table></div>

    <h3>${esc(t.metaJudge)}</h3>
    <p class="judge-line"><code>${esc(judgeModel ?? t.noData)}</code> — ${esc(t.judgeRole)}.</p>
  </section>`;
}

// ---- agent-id shorteners ----

// "opus-4.8/loop/default" → "opus-4.8" (the model handle); the scaffold/prompt
// are constant across this fleet, so the handle alone is the legible label.
function shortAgent(id: string): string {
  return id.split("/")[0];
}
function scenarioShort(slug: string): string {
  // "02-missing-label" → "02 · missing label"
  const m = slug.match(/^(\d+)-(.+)$/);
  if (!m) return slug;
  return `${m[1]} · ${m[2].replace(/-/g, " ")}`;
}

// ---- the page ----

export type RenderInput = {
  result: MatrixResult;
  criteria: CriteriaByScenario;
  fleet: FleetModels;
  judgeModel: string | null;
};

export function renderReportHtml(input: RenderInput): string {
  const { result, criteria, fleet, judgeModel } = input;
  const t = UI;
  const rollups = buildAgentRollups(result);
  const rel = result.aggregate.measurement_reliability;

  const generated = result.generated_at.replace("T", " ").replace(/\.\d+Z$/, " UTC");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.docTitle)}</title>
<style>${STYLES}</style>
</head>
<body>
  <header>
    <div class="kicker">${esc(t.kicker)}</div>
  </header>

  <h1>${esc(t.title)}</h1>
  <p class="tagline">${esc(t.tagline)}</p>
  <p class="aggregate">
    <span class="num">${esc(t.metaGrid(result.config.agent_ids.length, result.config.scenario_slugs.length, result.config.runs, result.cells.length))}</span><br>
    ${esc(t.reliabilityLine(rel.flaky_cells, rel.total_cells, pct(rel.flaky_rate), fmtConf(rel.mean_judge_confidence)))}<br>
    <span class="meta-kv">${esc(t.metaGenerated)} <span class="num">${esc(generated)}</span> · ${esc(t.metaGit)} <code>${esc(result.git_sha.slice(0, 12))}</code> · ${esc(t.metaJudge)} <code>${esc(judgeModel ?? t.noData)}</code></span>
  </p>

  ${leaderboardSection(result, fleet, rollups, t)}
  ${heatmapSection(result, t)}
  ${discriminationSection(result, t)}
  ${criteriaSection(criteria, result, t)}
  ${scenariosSection(result, t)}
  ${whatWeTestedSection(result, fleet, judgeModel, t)}

  <footer>${esc(t.footer)}</footer>
</body>
</html>`;
}

// ---- styles: status.pome.sh "trinity hybrid", verbatim tokens ----

export const STYLES = `
  :root {
    --canvas:#faf9f5; --soft:#f5f0e8; --cream-card:#efe9de;
    --dark:#181715; --dark-soft:#1f1e1b; --dark-elev:#252320;
    --hairline:#e6dfd8; --hairline-dark:#2a2825;
    --ink:#141413; --body:#3d3d3a; --muted:#6c6a64;
    --on-dark:#faf9f5; --on-dark-soft:#a09d96;
    --moss:#4a6b3a; --moss-on-dark:#7ea766; --amber:#c8632e;
    --success:#5db872; --warning:#d4a017; --error:#c64545; --info:#5db8a6;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--canvas); color: var(--ink);
    font: 16px/1.55 Inter, system-ui, -apple-system, sans-serif;
    max-width: 1100px; margin: 0 auto; padding: 2.6rem 1.5rem 4rem;
    -webkit-font-smoothing: antialiased;
  }
  .num, code, time { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: lining-nums tabular-nums; font-feature-settings: "tnum" 1; }
  a { color: var(--ink); text-decoration: underline; text-decoration-color: var(--hairline); text-underline-offset: 2px; }
  a:hover { text-decoration-color: var(--ink); }
  code { font-size: .86em; background: rgba(0,0,0,.04); padding: .05em .35em; border-radius: 4px; }

  header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .kicker { font-size: .8rem; letter-spacing: .4px; color: var(--muted); text-transform: uppercase; }

  h1 {
    font-family: "Source Serif 4","Source Serif Pro",Georgia,serif;
    font-weight: 400; font-size: 2.3rem; line-height: 1.12; letter-spacing: -0.5px;
    margin: 1.8rem 0 .5rem; max-width: 26ch;
  }
  .tagline { color: var(--body); margin: 0 0 1rem; max-width: 64ch; font-size: 1.04rem; }
  .aggregate { color: var(--muted); margin: 0 0 2.4rem; font-size: .9rem; line-height: 1.8; }
  .aggregate .num { color: var(--ink); }
  .meta-kv { font-size: .82rem; }

  section.card {
    background: var(--dark); color: var(--on-dark);
    border-radius: 14px; padding: 30px 32px; margin-bottom: 1.5rem;
  }
  section.card h2 {
    font-family: "Source Serif 4","Source Serif Pro",Georgia,serif;
    font-weight: 400; font-size: 1.5rem; margin: 0 0 .3rem; color: var(--on-dark);
  }
  section.card h3 {
    font-family: "Source Serif 4","Source Serif Pro",Georgia,serif;
    font-weight: 400; font-size: 1.05rem; margin: 1.5rem 0 .6rem; color: var(--on-dark);
  }
  .note { color: var(--on-dark-soft); margin: 0 0 1.3rem; font-size: .9rem; max-width: 76ch; }
  .micro { color: var(--on-dark-soft); margin: .9rem 0 0; font-size: .78rem; }

  /* tables */
  .table-wrap { overflow-x: auto; margin: .2rem -6px 0; padding: 0 6px; }
  table { border-collapse: collapse; width: 100%; margin: 0; font-size: .85rem; }
  th, td { text-align: left; padding: .5rem .7rem .5rem 0; border-bottom: 1px solid var(--hairline-dark); vertical-align: middle; }
  thead th { color: var(--on-dark-soft); font-weight: 500; font-size: .73rem; letter-spacing: .2px; }
  td.num, th.num { white-space: nowrap; text-align: right; padding-right: .9rem; }
  tbody tr:last-child td { border-bottom: none; }
  td code, .judge-line code { background: rgba(255,255,255,.06); color: var(--on-dark); }
  .row-used td { background: rgba(126,167,102,.07); }

  /* leaderboard bars */
  .leaderboard { display: grid; gap: .4rem; margin-bottom: 1.6rem; }
  .lb-row { display: grid; grid-template-columns: 1.4rem 9rem 1fr 3rem; align-items: center; gap: .7rem; }
  .lb-rank { color: var(--on-dark-soft); font-size: .8rem; text-align: right; }
  .lb-name { font-size: .85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lb-track { height: 12px; background: var(--hairline-dark); border-radius: 9999px; overflow: hidden; }
  .lb-fill { display: block; height: 100%; background: var(--moss-on-dark); border-radius: 9999px; }
  .lb-val { text-align: right; font-size: .85rem; }

  /* heatmap */
  table.heatmap { border-collapse: separate; border-spacing: 3px; width: auto; min-width: 100%; }
  table.heatmap th { border: none; }
  .hm-col { color: var(--on-dark-soft); font-weight: 500; font-size: .72rem; text-align: center; white-space: nowrap; padding: 0 .2rem .35rem; }
  .hm-rowhead { color: var(--on-dark); font-weight: 500; font-size: .8rem; text-align: right; padding-right: .6rem; white-space: nowrap; border: none; }
  td.hm {
    font-family: "JetBrains Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums;
    text-align: center; min-width: 3.2rem; padding: .55rem .3rem; border-radius: 6px;
    font-size: .82rem; border: 1px solid transparent;
  }
  td.hm-flaky { border: 1px dashed var(--amber); }
  td.hm-empty { background: var(--dark-elev); color: var(--on-dark-soft); }
  .hm-legend { display: flex; align-items: center; gap: .5rem; margin-top: 1rem; font-size: .76rem; color: var(--on-dark-soft); }
  .hm-grad { display: inline-block; width: 120px; height: 10px; border-radius: 9999px; background: linear-gradient(90deg, rgb(238,243,233), rgb(47,74,36)); }
  .hm-flaky-key { margin-left: auto; display: inline-flex; align-items: center; gap: .35rem; }
  .hm-flaky-key i { display: inline-block; width: 14px; height: 14px; border: 1px dashed var(--amber); border-radius: 4px; }

  /* discrimination */
  .discrimination { display: grid; gap: .5rem; }
  .disc-row { display: grid; grid-template-columns: 11rem 1fr auto; align-items: center; gap: .7rem; }
  .disc-name { font-size: .85rem; white-space: nowrap; }
  .disc-track { height: 12px; background: var(--hairline-dark); border-radius: 9999px; overflow: hidden; }
  .disc-fill { display: block; height: 100%; border-radius: 9999px; }
  .disc-fill.disc-hi { background: var(--moss-on-dark); }
  .disc-fill.disc-low { background: var(--on-dark-soft); }
  .disc-meta { display: inline-flex; align-items: center; gap: .5rem; font-size: .8rem; }

  .tag { font-size: .68rem; padding: .12rem .5rem; border-radius: 9999px; white-space: nowrap; border: 1px solid var(--hairline-dark); color: var(--on-dark-soft); }
  .tag.disc-hi { color: var(--moss-on-dark); border-color: rgba(126,167,102,.4); }
  .tag.disc-low { color: var(--on-dark-soft); }
  .role-baseline { color: var(--on-dark-soft); }
  .role-discriminator { color: var(--moss-on-dark); border-color: rgba(126,167,102,.4); }
  .role-restraint { color: var(--warning); border-color: rgba(212,160,23,.4); }
  .role-security { color: var(--error); border-color: rgba(198,69,69,.45); }
  .role-correction { color: var(--info); border-color: rgba(93,184,166,.4); }

  /* per-criterion small multiples */
  .crit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 1.1rem; }
  .crit-card { background: var(--dark-soft); border: 1px solid var(--hairline-dark); border-radius: 10px; padding: 16px 18px; }
  .crit-card h3 { margin: 0 0 .7rem; font-size: .95rem; }
  .crit-rows { display: grid; gap: .55rem; }
  .crit-row { display: grid; grid-template-columns: 1fr; gap: .25rem; }
  .crit-text { font-size: .79rem; color: var(--on-dark); line-height: 1.45; }
  .crit-kind { color: var(--on-dark-soft); font-size: .72rem; }
  .crit-glyph { font-weight: 700; margin-right: .35rem; }
  .crit-glyph.crit-ok { color: var(--success); }
  .crit-glyph.crit-mid { color: var(--warning); }
  .crit-glyph.crit-bad { color: var(--error); }
  .crit-glyph.crit-uneval { color: var(--muted); }
  .crit-row { display: grid; grid-template-columns: 1fr 5rem 2.6rem; align-items: center; gap: .6rem; }
  .crit-track { height: 8px; background: var(--hairline-dark); border-radius: 9999px; overflow: hidden; }
  .crit-fill { display: block; height: 100%; border-radius: 9999px; }
  .crit-fill.crit-ok { background: var(--success); }
  .crit-fill.crit-mid { background: var(--warning); }
  .crit-fill.crit-bad { background: var(--error); }
  .crit-fill.crit-uneval { background: var(--muted); }
  .crit-val { text-align: right; font-size: .78rem; }

  /* scenario explainers */
  .scn-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 1.1rem; }
  .scn { background: var(--dark-soft); border: 1px solid var(--hairline-dark); border-radius: 10px; padding: 18px 20px; }
  .scn-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .5rem; }
  .scn-slug { font-size: .76rem; color: var(--on-dark-soft); }
  .scn h3 { margin: 0 0 .6rem; font-size: 1.08rem; }
  .scn p { font-size: .85rem; color: var(--on-dark); margin: .35rem 0; line-height: 1.5; }
  .scn-lbl { color: var(--moss-on-dark); font-weight: 600; font-size: .73rem; text-transform: uppercase; letter-spacing: .3px; margin-right: .25rem; }
  .scn-link { display: inline-block; margin-top: .7rem; font-size: .8rem; color: var(--on-dark); text-decoration-color: var(--hairline-dark); }
  .scn-link:hover { text-decoration-color: var(--on-dark); }

  .judge-line { font-size: .88rem; color: var(--on-dark); }
  footer { color: var(--muted); font-size: .82rem; border-top: 1px solid var(--hairline); margin-top: 2.2rem; padding-top: 1.2rem; max-width: 70ch; }

  @media (max-width: 640px) {
    body { padding: 2rem 1.1rem 3rem; }
    section.card { padding: 22px 18px; }
    h1 { font-size: 1.85rem; }
    .lb-row { grid-template-columns: 1.2rem 6rem 1fr 2.6rem; gap: .4rem; }
    .disc-row { grid-template-columns: 7rem 1fr; }
    .disc-meta { grid-column: 1 / -1; }
  }
`;

// ---- public: read a results dir → the HTML string ----

export async function loadAndRender(
  resultsDir: string,
  judgeModelOverride?: string | null,
): Promise<{ html: string; result: MatrixResult }> {
  const matrixPath = join(resultsDir, "matrix.json");
  const raw = await readFile(matrixPath, "utf8");
  const result = JSON.parse(raw) as MatrixResult;
  const criteria = buildCriteriaData(result);
  const fleet = buildFleetModels(result.config.agents_file);
  // Judge model: prefer a per-cell judge_model recorded in the matrix; fall
  // back to the override (the --judge-model the run used).
  const judgeFromCells =
    result.cells.map((c) => c.judge_model).find((j) => j !== null) ?? null;
  const judgeModel = judgeFromCells ?? judgeModelOverride ?? null;
  const input: RenderInput = { result, criteria, fleet, judgeModel };
  return {
    html: renderReportHtml(input),
    result,
  };
}
