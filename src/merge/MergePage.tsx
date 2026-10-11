import { useEffect, useState } from "react";
import { Button, Card, TopBar, segmentClass } from "../components/ui";
import { applyMerge, finishMerge, loadMergeSnapshots } from "../db";
import { timeStamp } from "../familyFile";
import { buildPlan, isEmptyPlan, type Choice, type MergePlan } from "./plan";

interface Props {
  /** Called once the merge is finished or cancelled and the staged file has been cleared away. */
  onDone: () => Promise<void>;
}

/** "3 people", "1 person"; null when there are none, so callers can drop the line. */
function count(n: number, one: string, many: string): string | null {
  return n === 0 ? null : `${n} ${n === 1 ? one : many}`;
}

function additions(plan: MergePlan): string[] {
  const { inserts } = plan;
  return [
    count(inserts.person.length, "person", "people"),
    count(inserts.event.length, "event", "events"),
    count(inserts.media.length, "photo", "photos"),
    count(inserts.audio.length, "recording", "recordings"),
    count(inserts.partnership.length + inserts.parent_child.length, "family link", "family links"),
    count(inserts.event_participant.length, "link between a person and an event", "links between people and events"),
    count(plan.fills.length, "record with blanks filled in", "records with blanks filled in"),
  ].filter((line): line is string => line !== null);
}

/** Shown instead of the tree while a family file is waiting to be merged. */
export function MergePage({ onDone }: Props) {
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the merge has been applied: where the overridden copies went, or null if there were none.
  const [result, setResult] = useState<{ overridesDir: string | null } | null>(null);

  useEffect(() => {
    loadMergeSnapshots().then(
      ({ mine, theirs }) => setPlan(buildPlan(mine, theirs)),
      (e) => setError(String(e)),
    );
  }, []);

  async function close() {
    setBusy(true);
    try {
      await finishMerge();
    } catch (e) {
      setError(String(e));
    }
    await onDone();
  }

  const conflicts = plan ? [...plan.conflicts, ...plan.parentConflicts] : [];
  const unsettled = conflicts.filter((conflict) => !choices[conflict.key]).length;
  const chooseAll = (choice: Choice) =>
    setChoices(Object.fromEntries(conflicts.map((conflict) => [conflict.key, choice])));

  async function merge() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      setResult({ overridesDir: await applyMerge(plan, choices, timeStamp()) });
    } catch (e) {
      setError(`The merge could not be done, and your tree has not been changed: ${e}`);
    }
    setBusy(false);
  }

  const added = plan ? additions(plan) : [];

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <h1 className="font-serif text-xl font-semibold">Merge a family file</h1>
        <div className="flex-1" />
        {!result && (
          <Button disabled={busy} onClick={close}>
            Cancel merge
          </Button>
        )}
      </TopBar>

      <main className="flex-1 overflow-y-auto px-4 pt-6 pb-12">
        <div className="mx-auto flex max-w-[820px] flex-col gap-5">
          {error && <p className="text-danger">{error}</p>}
          {!plan && !error && <p className="text-muted">Comparing the file with your tree…</p>}

          {result && plan && (
            <Card title="Merge complete">
              <div className="flex flex-col gap-3">
                <p>The file has been merged into your tree.</p>
                <p>A copy of your tree from before the merge was saved in the backups folder.</p>
                {result.overridesDir && (
                  <p>
                    For the differences you settled, a copy of each tree that lost out was kept, so anything
                    overridden can be looked up and added back by hand. They are family files in:
                    <br />
                    <code className="rounded-sm bg-paper px-1 py-0.5 text-[13px] break-all">{result.overridesDir}</code>
                  </p>
                )}
                {plan.possibleDuplicates.length > 0 && (
                  <p>
                    Check for people who are now in the tree twice. These names were added but were already there:{" "}
                    <strong className="font-semibold">{plan.possibleDuplicates.join(", ")}</strong>.
                  </p>
                )}
                <div>
                  <Button variant="primary" disabled={busy} onClick={close}>
                    Go to the tree
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {plan && !result && (
            <>
              <Card title="What the file adds">
                {isEmptyPlan(plan) ? (
                  <p>Nothing. Your tree already has everything that is in this file.</p>
                ) : added.length === 0 ? (
                  <p>Nothing new, but the two disagree on the points below.</p>
                ) : (
                  <ul className="list-disc pl-6">
                    {added.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-muted">
                  Merging never removes anything from your tree. Something deleted in the file but still in your tree
                  stays.
                </p>
                {plan.possibleDuplicates.length > 0 && (
                  <p className="mt-3">
                    The file adds people whose names are already in your tree:{" "}
                    <strong className="font-semibold">{plan.possibleDuplicates.join(", ")}</strong>. If they are the
                    same people, they will be in the tree twice after the merge.
                  </p>
                )}
                {plan.skippedLinks > 0 && (
                  <p className="mt-3">
                    {count(plan.skippedLinks, "parent link was", "parent links were")} left out because it would make
                    someone their own ancestor.
                  </p>
                )}
              </Card>

              {conflicts.length > 0 && (
                <Card
                  title={`Differences to settle (${conflicts.length})`}
                  action={
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => chooseAll("mine")}>
                        Keep mine for all
                      </Button>
                      <Button size="sm" onClick={() => chooseAll("theirs")}>
                        Use the file's for all
                      </Button>
                    </div>
                  }
                >
                  <p className="mb-4 text-muted">
                    Your tree and the file say different things here. Choose which to keep for each one. Whichever you
                    do not choose is not lost: a copy of that whole tree is kept in the overrides folder.
                  </p>
                  <div className="flex flex-col gap-4">
                    {conflicts.map((conflict) => (
                      <article className="flex flex-col gap-3 rounded-lg border border-line p-4" key={conflict.key}>
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs text-muted">{conflict.kind}</div>
                            <h3 className="font-serif text-base font-semibold">{conflict.title}</h3>
                          </div>
                          <div className="flex flex-none">
                            {(["mine", "theirs"] as const).map((choice) => (
                              <button
                                key={choice}
                                className={segmentClass(choices[conflict.key] === choice)}
                                onClick={() => setChoices((current) => ({ ...current, [conflict.key]: choice }))}
                              >
                                {choice === "mine" ? "Keep mine" : "Use the file's"}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="grid grid-cols-[110px_1fr_1fr] gap-x-3 gap-y-2">
                          <span />
                          <span className="text-xs text-muted">In your tree</span>
                          <span className="text-xs text-muted">In the file</span>
                          {conflict.differences.map((difference) => (
                            // "contents" removes this wrapper from the layout, so its three children are grid cells.
                            <div className="contents" key={difference.label}>
                              <span className="text-xs text-muted">{difference.label}</span>
                              <span className="max-h-40 overflow-y-auto break-words whitespace-pre-wrap">
                                {difference.mine}
                              </span>
                              <span className="max-h-40 overflow-y-auto break-words whitespace-pre-wrap">
                                {difference.theirs}
                              </span>
                            </div>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                </Card>
              )}

              <div className="flex items-center justify-end gap-3">
                {unsettled > 0 && <span className="text-muted">{count(unsettled, "difference", "differences")} still to settle</span>}
                {busy && <span className="text-muted">Merging… this can take a while with many photos.</span>}
                <Button variant="primary" disabled={busy || unsettled > 0 || isEmptyPlan(plan)} onClick={merge}>
                  Merge into my tree
                </Button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
