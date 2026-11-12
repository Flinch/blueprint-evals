# blueprint-evals

An open-source framework for testing AI agents.

It drives simulated users through conversations with an agent, records exactly
what happened, grades the result with deterministic checks and calibrated LLM
judges, and reports a verdict you can audit.

**Status:** early. Implemented and tested: the interfaces, the verdict
aggregation rule, the `http` target, the stub agent, the graders
(deterministic checks, the rubric judge, goal check) and the Anthropic model
provider (tested against a fake client; an opt-in live test is included). The
simulator, runner and CLI are next. See the [M0 design doc](docs/design/0001-m0-core-interfaces.md) for
the plan and the reasoning.

## Why another eval tool

Most eval tools grade what an agent *said*. This one is built around grading
what the agent *did*: tool calls, their order, and (in later milestones) the
state of the system of record afterwards. It also treats the judge itself as a
system under test, with human-agreement and bias measurement, and it separates
"the agent failed" from "the test infrastructure failed" so a timeout never
shows up as a bad score.

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

## Planned quickstart

Not runnable yet. This is the shape the CLI is being built toward:

```bash
evals validate examples/scenarios/
evals run examples/scenarios/ --config examples/evals.config.yaml
```

The `run` command prints the maximum it could cost before it spends anything.

## Develop

```bash
npm install
npm test
```

Node 20 or later.

## License

Apache-2.0. See [LICENSE](LICENSE).
