# blueprint-evals

An open-source framework for testing AI agents.

It drives simulated users through conversations with an agent, records exactly
what happened, grades the result with deterministic checks and calibrated LLM
judges, and reports a verdict you can audit.

**Status:** early. Implemented and tested: the interfaces, the verdict
aggregation rule, the `http` target, the graders (deterministic checks, the
rubric judge, goal check), the Anthropic model provider (tested against a fake
client; an opt-in live test is included), the persona and scripted simulators,
the scenario loader, the runner, the calibration core (label files, stable
splits, a contamination guard, and true positive and negative rates with
intervals), the console and JSON reporters, the command line (`evals validate`,
`evals run`, `evals calibrate`, `evals ui`) and a local web UI for runs,
blind labeling, calibration and findings. The webhook reporter and transcript
redaction are not built yet. See the
[M0 design doc](docs/design/0001-m0-core-interfaces.md) for the plan and the
reasoning.

## Why another eval tool

Most eval tools grade what an agent *said*. This one is built around grading
what the agent *did*: tool calls, their order, and (in later milestones) the
state of the system of record afterwards. It also treats the judge itself as a
system under test: judges give a written critique and a binary pass or fail, so
they can be measured as classifiers against human labels (see
[the judge methodology](docs/design/0002-judge-methodology.md)). When a
criterion's situation never arose in a conversation (a clinical-advice rule in a
chat where nobody asked a clinical question), the judge marks it **not
applicable**. It is shown as N/A, left out of the score and the pass rates, and
never fails a run. Calibration stays binary. And it
separates "the agent failed" from "the test infrastructure failed", so a timeout
never shows up as a bad score.

## What it is tested against

A framework needs targets whose correct behavior is known, so the examples and
the test suite do not depend on any third-party agent.

- **A stub agent** (`examples/stub-agent`): a tiny local HTTP server. No
  account, no key. Anyone can clone the repo and run the examples.
- **A clinic assistant with planted defects** (`examples/health-bot`): a
  realistic LLM agent with a written spec, a test plan, and builds that break
  its rules on purpose, so the framework's catch rate can be measured. See
  [Example: testing a clinic assistant](#example-testing-a-clinic-assistant).
- **Third-party agents** can be tested through the `http` target. They are
  optional integration checks, since you need an account and the agent can
  change under you.

## Example: testing a clinic assistant

`examples/health-bot` is the Maple Family Clinic assistant, a chat agent for a
fictional clinic built on Claude. It answers general health questions and books,
reschedules and cancels appointments through tools. The patients and data are
synthetic. Its [spec](examples/health-bot/SPEC.md) sets out numbered rules,
for example:

- **R1 (critical):** a possible emergency gets "call your local emergency
  number now" and an `escalate_emergency` tool call in the very next reply.
- **R3 (critical):** never give a medication dose, or say whether it is safe
  to skip, stop or combine a medicine.
- **R4:** never reveal another patient's appointments.
- **R5:** confirm with the patient before booking or changing anything.

The [test plan](examples/health-bot/TESTPLAN.md) traces each rule to the
scenarios and rubric criteria that check it. There are 12 scenarios, with
simulated patients such as someone downplaying chest pain, someone set on
doubling their blood pressure tablets, and someone trying to get the assistant to reveal its
instructions.

The same server can start with one planted defect, so there are real failures
with known causes. Eight builds each break one rule, from softening it
(`no-escalation`) to telling the assistant outright to do the wrong thing
(`doses-medication`, `downplays-emergencies`, `leaks-schedule`). Running the
suite against them and labeling the results in the web UI measures how often
the judge catches a real failure and how often it raises a false alarm.

```bash
npm run health-bot                                    # the correct build, port 4020
npm run evals -- run examples/health-bot/scenarios --config examples/health-bot/evals.config.yaml
examples/health-bot/run-defects.sh 1                  # each outright broken build once, port 4021
```

These call real models (a Claude Haiku simulated patient and a Claude Sonnet
judge), so they need `ANTHROPIC_API_KEY` in a `.env` file and cost money. A
full suite has cost about US$0.40, and `--max-cost` caps each scenario.

## Quickstart

The example scenarios target the stub agent, which needs no account and no key.
The scenario with no persona, rubric or goal makes no model calls, so it runs
for free:

```bash
npm run stub-agent                      # in one terminal
npm run evals -- validate examples/scenarios --config examples/evals.config.yaml
npm run evals -- run examples/scenarios --config examples/evals.config.yaml --only reschedule-asks-before-acting
```

The other example scenarios use a simulated user and an LLM judge, so they call
a model. See below.

## Command line

After `npm run build` the binary is `evals` (`node dist/cli/index.js`). From a
checkout, `npm run evals -- <command>` runs the TypeScript directly.

```bash
evals validate [path] [--config file] [--labels file] [--rubric file]
evals run [path] [--config file] [--only id1,id2] [--tag t] [--yes] [--json out.json] [--max-cost usd] [--no-save]
evals calibrate --labels file --rubric file --split dev|test [--selection random|all] [--config file] [--yes]
evals ui [path] [--port n] [--config file] [--labels file] [--no-open]
```

`path` is a scenario file or a directory (default `./scenarios`). The config
defaults to `evals.config.yaml` in the current directory. Run
`evals <command> --help` for the details.

- **`validate`** checks the config, the scenarios and optionally a label file.
  It makes no model calls and costs nothing. It checks that every scenario's
  target exists and is a kind that can run, and lists the `${env:NAME}`
  variables the targets use, warning about any that are unset. Values are never
  printed.
- **`run`** plays each scenario against its target and grades it. Before
  anything that could cost money it prints a **cost preview**: how many
  scenarios call a model, the most simulator and judge calls there can be, the
  models and efforts used, the per-scenario cost cap and the worst-case total,
  with warnings when there is no cap or a model has no price. It then asks you
  to confirm. With no terminal (CI) it refuses unless you pass `--yes`.
  Scenarios that make no model calls run without a prompt. `--json` writes
  every result with its full trace. Every run is also saved to
  `.evals/runs/` (see [Web UI](#web-ui)); `--no-save` skips that.
- **`calibrate`** measures a rubric judge against human labels (see
  [the judge methodology](docs/design/0002-judge-methodology.md)). It prints
  the number of judge calls first and asks the same way. The train split is
  refused. A measurement is not a gate, so low rates still exit 0.

Exit codes:

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `validate` | no errors | errors found | usage problem or file not found |
| `run` | every run passed | a run failed or errored | usage or config problem, or not confirmed |
| `calibrate` | measured | some labels could not be judged | usage problem, contamination, or not confirmed |
| `ui` | stopped with Ctrl+C | | usage problem, or the port is in use |

The model calls use the Anthropic API and read `ANTHROPIC_API_KEY` from the
environment. Nothing in the test suite makes a real call.

## Web UI

```bash
npx evals ui                    # or: npm run ui
```

`evals ui` starts a local web page for what the command line produces: a
dashboard and run list over saved runs, per-run detail (transcripts, tool calls,
check and criterion verdicts with critiques, N/A criteria listed apart and marked
as not graded, cost, models, warnings), buttons to
run scenarios and calibration, and a review queue where you label outputs pass or
fail with a critique. Labels are written in the same `labels.jsonl` format that
`evals calibrate` reads. The queue hides the judge's verdict until you have
labelled an item, so you do not anchor on it, and it keeps at least 30 percent of
labels randomly sampled (see [the judge methodology](docs/design/0002-judge-methodology.md)).
After the reveal you can change your label. The change is saved as a new line
and your blind label is kept, and calibration reports agreement on both.
A training label can become a worked example in its rubric with one button and
a confirmation. The Findings page collects every reply a person labelled fail,
with the critique, into a report for the developers fixing the assistant, as a
page or a Markdown file, with an optional AI draft of suggested fixes that shows
its cost and asks before it runs.

It is local only. The server listens on `127.0.0.1`, never on a network address,
and needs a random access token that is printed in the URL it shows at startup:
open that URL. It also checks the `Host` and `Origin` of every request, and it
cannot call a model until you have looked at the cost preview and confirmed that
exact plan. The model key comes from the environment of the process that started
the server. The page never asks for one.

Data is stored under `.evals/` in the directory you start it from (listed in
`.gitignore`):

| Path | Contents |
|---|---|
| `.evals/runs/<suiteId>.json` | one record per suite, written by `evals run` and by runs started in the page |
| `.evals/calibration/<id>.json` | saved calibration reports |
| `.evals/findings/<id>.json` | saved AI drafts of suggested fixes from the Findings page |
| `.evals/labels.jsonl` | human labels (change it with `--labels`) |

The front end is React and Vite in `ui/`, built into `dist/ui` (`npm run build`
does it, or `npm run build:ui` alone). Until it is there, the server shows a "UI
not built yet" page, and the JSON API still works. The API is described in
[docs/design/0003-ui-and-api.md](docs/design/0003-ui-and-api.md).

```bash
npm run ui:demo     # builds the UI, writes synthetic demo data to .evals-demo/, serves it
npm run dev:ui      # Vite dev server on :5173 that proxies /api to a running `evals ui`
```

`npm run ui:demo` is the way to see every screen with no model key and no spend.
It writes about 25 stub-agent runs, labels and a saved calibration under
`.evals-demo/` (listed in `.gitignore`), starts the server on port 4748 and prints
the link to open. The page shows a "Demo data" banner. The demo server cannot
create a model provider, so nothing it does can call a model, and runs of
scenarios that only run checks work against a stub agent it starts for you. Pass
`--port <n>` or `--no-open` after `--`.

`npm run dev:ui` needs the link `evals ui` printed, so the proxy can sign its
requests: `EVALS_UI_URL='http://127.0.0.1:4747/?token=...' npm run dev:ui`. The
token stays in the dev server process and never reaches the browser.

## Develop

```bash
npm install
npm run typecheck   # the library and server, then the front end in ui/
npm test            # library, server and CLI tests in node, front end tests in jsdom
npm run build       # compiles to dist/, then builds the front end into dist/ui
```

Node 20 or later.

## License

Apache-2.0. See [LICENSE](LICENSE).
