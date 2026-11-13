# blueprint-evals

An open-source framework for testing AI agents.

It drives simulated users through conversations with an agent, records exactly
what happened, grades the result with deterministic checks and calibrated LLM
judges, and reports a verdict you can audit.

**Status:** early. Implemented and tested: the interfaces, the verdict
aggregation rule, the `http` target, the stub agent, the graders
(deterministic checks, the rubric judge, goal check), the Anthropic model
provider (tested against a fake client; an opt-in live test is included), the
persona and scripted simulators, the scenario loader, the runner, the
calibration core (label files, stable splits, a contamination guard, and true
positive and negative rates with intervals), the console and JSON reporters,
and the command line (`evals validate`, `evals run`, `evals calibrate`). The
webhook reporter and redaction are not built yet. See the
[M0 design doc](docs/design/0001-m0-core-interfaces.md) for the plan and the
reasoning.

## Why another eval tool

Most eval tools grade what an agent *said*. This one is built around grading
what the agent *did*: tool calls, their order, and (in later milestones) the
state of the system of record afterwards. It also treats the judge itself as a
system under test: judges give a written critique and a binary pass or fail, so
they can be measured as classifiers against human labels (see
[the judge methodology](docs/design/0002-judge-methodology.md)). And it
separates "the agent failed" from "the test infrastructure failed", so a timeout
never shows up as a bad score.

## What it is tested against

A framework needs targets whose correct behavior is known, so the examples and
the test suite do not depend on any third-party agent.

- **A stub agent** (`examples/stub-agent`, M0): a tiny local HTTP server. No
  account, no key. Anyone can clone the repo and run the examples.
- **The bug zoo** (M1): small agents we control, each with defects planted on
  purpose, so the framework's catch rate can be measured.
- **Third-party agents** such as Vapi's chat API are supported through
  adapters. They are optional integration checks, since you need an account
  and the agent can change under you. Vapi examples live under
  `examples/vapi/` and are marked as requiring one.

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
evals run [path] [--config file] [--only id1,id2] [--tag t] [--yes] [--json out.json] [--max-cost usd]
evals calibrate --labels file --rubric file --split dev|test [--selection random|all] [--config file] [--yes]
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
  every result with its full trace.
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

The model calls use the Anthropic API and read `ANTHROPIC_API_KEY` from the
environment. Nothing in the test suite makes a real call.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build
```

Node 20 or later.

## License

Apache-2.0. See [LICENSE](LICENSE).
