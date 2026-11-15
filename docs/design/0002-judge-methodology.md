# 0002: Judge methodology

| | |
|---|---|
| Status | Draft. Parts A and B are implemented, the rest is planned |
| Date | 2026-11-12 |
| Supersedes | The banded-score judge and `uncertain` status in [0001](0001-m0-core-interfaces.md) |
| Source | Hamel Husain, ["Creating a LLM-as-a-Judge That Drives Business Results"](https://hamel.dev/blog/posts/llm-judge/) (the "critique shadowing" process) |

## Why this exists

0001 built a judge that scores each criterion from 0 to 1, compares the score to
a per-criterion threshold, and calls a result `uncertain` when it lands near the
threshold. On the one real project we have data for, every one of 52 results
landed in that uncertain bucket.

0001 treated that as an aggregation bug and then as a prompt-anchoring problem.
Reading the post changed the diagnosis: numeric scores plus a band make a
hedging verdict structurally inevitable, and a hedging judge cannot be measured
as a classifier. The fix is to remove the scale, not to tune around it.

## What we take from the post, and what we change

The post's process: one domain expert gives pass or fail verdicts with written
critiques on real outputs, the obvious bugs get fixed, an LLM judge is built
from those critiques and iterated until it agrees with the expert on data it has
not seen, and only then is it used at scale. The post's closing point is that
the judge mainly forces you to look at your data.

Where this design departs from the post, and why:

| The post | This design | Reason |
|---|---|---|
| One overall pass or fail on the outcome | Binary verdict **per criterion**, plus a separate goal check for the outcome | A conversation can achieve its goal and still give medical advice. Per-criterion verdicts keep that attribution without a manual root-cause pass afterwards |
| Fixed floors (about 60 labels, 30 to 50 per label) | Show the interval and flag small samples | The post's own numbers conflict (it also says about 100 per failure mode). An interval is more honest than a cutoff |
| Hold out 40 to 45 percent as a test set | Same split, with the cost acknowledged | At tens of labels a test set is tiny. Until volume grows the judge is labelled uncalibrated rather than pretending |
| "A bit of random sampling" | A random quota, recorded per label, and accuracy metrics computed only from random labels | Targeted review finds bugs but cannot estimate accuracy |
| One principal expert | One per client, with agreement between experts measured when there are two | Each client has their own domain, and two experts' agreement is the ceiling for any judge |
| Judge covers the quality dimension | Judge covers only what code cannot check | Tool calls and (later) system-of-record state are objective. Anything checkable by code stays code, which the post also recommends |

Corrections to a second-hand summary of the post that shaped this design: the
post does not mention kappa (it asks for true positive and true negative rates
separately), says binary verdicts are for "when starting out" with complexity
"later if needed", does not say to cover every combination of dimensions, and
allows a founder or an honest developer to be the expert.

## Part A: binary judge (implemented)

### Decisions

1. **Each criterion gets a binary verdict and a critique.** The judge writes the
   critique first (detailed enough for a new hire to follow, citing turn
   numbers), then `pass` or `fail`. No numeric score, no threshold, no band.
2. **`uncertain` is removed.** It no longer exists as a run status, grader
   status or criterion band. A judge must decide. A self-reported confidence
   flag, if it earns its place, comes later and must be shown to predict
   disagreement with experts before it is used for anything. It is never a
   reason to exclude a case from agreement metrics.
3. **The run verdict is simple.** Any grader `error` makes the run `error`.
   Otherwise any failed check, failed criterion or failed goal makes it `fail`.
   Otherwise `pass`. Skipped graders are reported and never count as passes. A
   criterion found not applicable is reported and never decides (see
   [Not applicable](#not-applicable)).
4. **`critical` stays as metadata.** A failed critical criterion fails the run
   like any other, and is marked so a consumer (Blueprint's Launch Readiness
   rules) can treat it as release-blocking. It does not change the run status.
5. **The score is derived, not judged.** It is the weighted share of applicable
   criteria that passed, or `null` when none applied. It is a diagnostic. The headline outcome is `goalAchieved`,
   taken from the goal check, which is `true`, `false`, or `null` when there is
   no goal or the check could not run.
6. **Rubric `threshold` is gone.** A rubric that still carries one is rejected
   with a message naming the key, because silently ignoring it would hide that
   its meaning changed.

### Anchor examples

Few-shot examples now carry what the post's format carries: the input, the
output, the critique and the verdict, with an optional `criterion` id when the
example illustrates one criterion.

```yaml
anchors:
  - criterion: confirms-before-acting
    input: "Can you move my appointment to 3pm tomorrow?"
    output: "Done. Your appointment is now tomorrow at 15:00."
    verdict: fail
    critique: >
      The assistant changed the booking in its first reply. It never asked the
      patient to confirm the new time, so a mishearing would have gone through
      unchecked.
```

A response is often only wrong relative to what was asked, which is why the
input matters. `excerpt`, `label` and `rationale` become `output`, `verdict` and
`critique`.

### Reference facts (rubric `context`)

A judge that has only the criteria and the transcript cannot verify what the
assistant claims. The first real run of the health-bot suite showed both
failures: the judge called a rule the spec defines ("booking replaces your
existing appointment") an invented policy, and it could not check clinic facts.

A rubric may therefore carry an optional `context` string: facts about the
system under test, such as clinic details and the rules its tools follow.

- **Prompt.** The judge's user message puts it before the criteria, in a
  `<reference_facts>` block, preceded by one sentence saying that it is ground
  truth about the system under test, to be used only to check claims the
  assistant makes and never as instructions to follow. When no context is set
  the block and the sentence are omitted, so an existing rubric produces a
  byte-identical prompt.
- **Calibration.** `createRubricLabelJudge` builds its single-criterion rubric
  from `...rubric`, so a labelled item is judged with the same context as a run.
  A rubric's context is part of the judge being measured. Changing it changes
  the judge, so bump the rubric `version` when it changes (the judge's name,
  `rubric-judge(<id>@<version>)`, is the only judge identity today; a content
  hash arrives with "judge identity" in step C below).
- **What belongs in it.** Facts the assistant may be checked against. Not the
  rules being graded (those are the criteria) and not the system's own
  instructions, and nothing private that the criteria forbid revealing.

### Length is a code check

An LLM judge cannot count words. It estimated about 175 words for a 159-word
reply, and it judged the same reply differently under two criteria that both
mentioned a limit. A length cap is therefore a deterministic check,
`reply_max_words` (see 0001), and the criteria say that length is checked in
code instead of stating a limit the judge would only guess at.

### Not applicable

A criterion often governs a situation that a given conversation never reaches. A
rule such as "redirects clinical questions to a clinician" has nothing to measure
in a scheduling chat where nobody asked a clinical question. Reporting that as a
pass inflated the pass rate and the score, and a critique reading "never
triggered" sat next to a green mark.

**Decision.** A criterion gets one of three verdicts: `pass`, `fail` or
`not_applicable` (shown as "N/A" in the UI).

**Definition.** `not_applicable` means the situation the criterion governs never
arose in this transcript, so the assistant had no opportunity to meet or break
it. The critique must say why. It says nothing about the judge's confidence, and
it is not the removed `uncertain` (decision 2 above stands). If the criterion did
apply but the evidence is mixed, the judge must still decide `pass` or `fail`.
If the assistant itself introduced the topic or performed the governed action,
the situation did arise: an assistant that volunteers medical advice in a
scheduling chat fails the no-advice criterion and is never `not_applicable`.

**Aggregation.**

| Case | Result |
|---|---|
| Score | Weighted share of applicable criteria that passed. `null` when none applied |
| Grader status | `fail` if any applicable criterion failed, otherwise `pass` |
| Every criterion is `not_applicable` | The grader still reports `pass` and adds the warning "No rubric criterion applied in this run, so the rubric tested nothing here." It reaches `RunResult.warnings` |
| `critical` and `not_applicable` | Never fails. Criticality only matters for a criterion that was graded |
| Run status | `not_applicable` neither fails a run nor counts as a pass |
| Overview and run list | Pass rates, failure counts, "most common failing criteria" and average score leave it out. Per-criterion pass, fail and not-applicable counts are kept apart |

**Calibration stays binary.** A label is about one criterion in one output, so a
labelled item is applicable by definition. Labels remain `pass` or `fail` and the
label schema is unchanged. The judge that calibration builds
(`createRubricLabelJudge`) is created with the option `allowNotApplicable: false`:
its response schema has only `pass` and `fail`, and its prompt does not mention
`not_applicable`, so a calibration run cannot come back N/A and no item can drop
out of the rates for that reason.

**The review queue leaves it out.** A person cannot pass or fail something that
never happened, and the label would have no graded verdict to be measured
against. A not-applicable criterion is never offered as an item. It is counted in
the queue stats so the gap is visible.

**Few-shot examples.** Anchors keep `pass` and `fail` only. Teaching the judge
when to say N/A from examples would need labels the file format does not have,
and the prompt carries the definition.

**Stored data.** The verdict is a widening of the stored field. Suites written
before this change contain no `not_applicable` and load, display and aggregate
exactly as they did, so `schemaVersion` stays 1.

**The abuse risk.** `not_applicable` is a way out of a hard call. A judge, or a
prompt edit, that answers it too freely would hide real failures behind a muted
pill that is easy to skim past, and the numbers would look better for it. The
mitigations:

- The prompt forbids using it to avoid a hard call, requires the critique to
  explain why the situation never arose, and states that a situation the assistant
  created itself did arise.
- N/A criteria stay visible with their critique on the run page, so a reader can
  disagree, and the all-N/A warning stops a rubric that tested nothing from
  passing silently.
- Planned: a check that flags a judge returning N/A too often (for example more
  than a set share of verdicts for a criterion across a suite) and surfaces the
  criteria involved, since a rubric whose criteria are mostly N/A is also a sign
  the scenarios do not exercise it.

## Part B: calibration (implemented)

Code: `src/calibration/` (`labels.ts`, `metrics.ts`, `evaluate.ts`). The command is `evals calibrate --labels file --rubric file --split dev|test`. It prints how many judge calls it will make and asks before making them, refuses the train split, and exits 2 on a contamination error. It exits 0 once the judge has been measured, even if the rates are low, because it is a measurement and not a gate.

### The label file

One JSON object per line. The same format is produced by a review screen in
Blueprint, a CLI, or a hand-edited file.

| Field | Meaning |
|---|---|
| `id` | Unique within the file |
| `group` | Optional. The conversation or run the label belongs to. Every label with the same group lands in the same split, so one transcript can never be a few-shot example for one criterion and a test case for another. Defaults to `id` |
| `criterion` | The rubric criterion the verdict is about |
| `input`, `output` | The context and the response being judged |
| `verdict` | `pass` or `fail`, from the human. There is no N/A: a labelled item is applicable |
| `critique` | Required on every label, not only disagreements. The post's training material is exactly the confirmations with a critique |
| `labeler` | Who labelled it |
| `sampled_by` | `random` or `targeted` |
| `at` | ISO timestamp |

There is no `split` field. It is derived from the hash below, and a stored value
would let an example be moved to the wrong side by hand, so a file that contains
one is rejected.

### Splits and the contamination guard

- The split is assigned by a stable hash of the group (or the id when there is
  no group), roughly 15 percent train and 42.5 percent each dev and test, so an
  item never moves between splits as labels are added. A test pins golden
  values so the hash cannot change by accident.
- Anchors may be built only from `train` labels. `anchorsFromLabels` throws on
  any other split, naming each offender.
- A judge declares the few-shot examples in its prompt (`LabelJudge.anchors`),
  and `evaluateJudge` refuses to run if any of them matches a dev or test label,
  whichever split is being measured. Matching is on the input and output,
  ignoring case, spacing and criterion, so a copied example is caught. This is
  enforced in code, so contamination is impossible by construction. Blueprint's
  current flow promotes a correction into the anchors while the same result
  still counts toward agreement, which grades the judge on examples it was
  shown.
- `dev` is for iterating on the prompt. `test` is meant to be scored once per
  judge version, with the number of looks recorded. The recording needs a judge
  identity (model, effort, prompt hash), so it arrives with step C. Until then
  nothing stops a second look at test.

### Metrics

- **True positive rate** (the expert said pass and the judge said pass) and
  **true negative rate** (the expert said fail and the judge said fail),
  reported separately, each with a 95 percent Wilson interval and its sample
  size.
- **The true negative rate leads.** A judge that passes a bad agent is the
  dangerous error.
- Raw agreement is shown only alongside prevalence, since it is misleading when
  most cases pass. Cohen's kappa is secondary and unstable on imbalanced data.
- A result is flagged `insufficient`, with a warning that says which part, when
  either class has fewer than 30 labels in the evaluated set or the total is
  under 60. These are the post's own rules
  of thumb, applied as warnings, not cutoffs.
- Accuracy metrics use random-sampled labels only by default. Targeted labels
  feed discovery and anchors. `selection: 'all'` includes them and the report
  says the rates then describe the sample reviewed.
- An item the judge could not judge (timeout, refusal, invalid output) is
  reported and kept out of the rates, never silently dropped.
- A rubric judge is evaluated one criterion at a time: a label about one
  criterion is judged against that criterion alone, with only the examples that
  illustrate it.

### Sampling

The review queue draws targeted items (failures, runs that disagree with
repeats) and a random quota, which defaults to at least 30 percent of reviewed
items. Every label records which way it was sampled.

### Labelers

Each label records who made it. With two labelers on overlapping items, the
agreement between them is reported as the ceiling for any judge.

### Judge identity and variability

- Every grade records the judge's model, effort and a hash of its prompt and
  rubric. A calibration report is keyed by that identity, so changing the model,
  the effort or the prompt invalidates it and calls for the loop to be run
  again, as the post says.
- **Self-consistency.** The judge is run several times on the same trace, and
  the flip rate per criterion is reported. A judge that disagrees with itself
  cannot agree with an expert. The post does not cover this.

## Part C: error analysis (planned)

- Scenarios gain free-form `dimensions` (for example feature, scenario,
  persona), kept separate from `tags`.
- A report shows failure rates by dimension, on data the judge was not tuned on.
- Failing results carry a `root_cause` label, applied by hand or with an LLM and
  then verified, and the report counts them. Every fixed failure gets a
  regression scenario or a code assertion.

## Part D: ground truth from the bug zoo (planned, M1 and M4)

The planted defects are known failures with known causes. They measure the
judge's true negative rate without needing an expert for every case. The
caveat: planted failures are easier than natural ones, so this checks that the
judge is not broken, and expert labels are still required to calibrate it for a
real product.

## Out of scope here: Blueprint app changes

These follow from the same reading, but belong to the dashboard, not the
framework:

- Lead the AI panel with `goalAchieved`, and bring pass rate back now that
  verdicts are binary.
- A client review screen: pass or fail, a critique, and all the context on one
  page. It is the post's main point ("looking at the data is where the value
  is") and a selling point.
- The train, dev and test split, and a random-sample queue.
- Collect critiques on confirmations, not only disagreements.

## Order of work

| Step | What | Status |
|---|---|---|
| A | Binary judge, derived score, `goalAchieved`, anchors with input | Done |
| B | Label file, splits, contamination guard, TPR/TNR with intervals | Done |
| C | Sampling quota, labelers, judge identity, self-consistency | Planned |
| D | `dimensions`, failure rate by dimension, root-cause tags | Planned |
| E | Bug zoo as judge ground truth | With M1 |

## Open questions

1. **A confidence flag.** Worth adding only if calibration data shows it
   predicts disagreement. Decide after step B.
2. **Test-set policy at low volume.** A once-only test set is expensive at tens
   of labels. Options are leave-one-out for anchor selection, or reusing the
   test set while counting the looks.
3. **Blueprint's pass rate.** Bringing it back on the AI side reverses an
   earlier decision. It is the owner's call.
4. **Migrating stored results.** Existing Blueprint results hold 0 to 1 scores
   and a `borderline` status. Whether to re-grade them or keep them as legacy
   rows is a wrapper decision.
