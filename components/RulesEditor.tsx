"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { CHANNEL_META, PRIORITY_META, TOPICS } from "@/lib/types";
import type { Tag, TicketPriority } from "@/lib/types";
import {
  ACTION_LABELS,
  CONDITION_FIELDS,
  CONDITION_FIELD_KEYS,
  MAX_REPLY_BODY,
  RULE_TRIGGERS,
  operatorLabel,
  type ConditionField,
  type ConditionOperator,
  type Rule,
  type RuleAction,
  type RuleActionType,
  type RuleCondition,
  type RuleDraft,
} from "@/lib/rules/types";
import { summarizeRule } from "@/lib/rules/describe";
import type { DryRunResult } from "@/lib/rules/engine";
import {
  deleteRule,
  reorderRules,
  saveRule,
  setRuleEnabled,
  testRule,
} from "@/app/(dashboard)/settings/rules/actions";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { XIcon } from "@/components/ui/icons";

interface AgentOption {
  id: string;
  name: string;
}

const EMPTY_DRAFT: RuleDraft = {
  name: "",
  trigger_on: "ticket_created",
  match_type: "all",
  conditions: [{ field: "topic", operator: "is", value: TOPICS[0] }],
  actions: [{ type: "assign", agent_id: null }],
};

/** A sensible starting condition for each field, so switching field is valid. */
function defaultCondition(field: ConditionField, tags: Tag[]): RuleCondition {
  const meta = CONDITION_FIELDS[field];
  const operator = meta.operators[0];
  switch (meta.valueKind) {
    case "channel":
      return { field, operator, value: "web_form" };
    case "topic":
      return { field, operator, value: TOPICS[0] };
    case "tag":
      return { field, operator, value: tags[0]?.name ?? "" };
    default:
      return { field, operator, value: "" };
  }
}

function defaultAction(type: RuleActionType): RuleAction {
  switch (type) {
    case "assign":
      return { type: "assign", agent_id: null };
    case "tag":
      return { type: "tag", tag_id: null };
    case "priority":
      return { type: "priority", priority: "high" };
    case "reply":
      return { type: "reply", body: "" };
  }
}

export default function RulesEditor({
  rules,
  agents,
  tags,
}: {
  rules: Rule[];
  agents: AgentOption[];
  tags: Tag[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  // Local copy so a reorder moves the row immediately rather than waiting on
  // a round trip; the server refresh is what makes it durable.
  const [order, setOrder] = useState<Rule[]>(rules);
  const [editing, setEditing] = useState<(RuleDraft & { id?: string }) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Rule | null>(null);

  // Props win on refresh — otherwise a save would leave the list showing the
  // pre-save order forever.
  const [seen, setSeen] = useState(rules);
  if (seen !== rules) {
    setSeen(rules);
    setOrder(rules);
  }

  const lookup = useMemo(
    () => ({
      agentName: (id: string | null) => agents.find((a) => a.id === id)?.name ?? null,
      tagName: (id: string | null) => tags.find((t) => t.id === id)?.name ?? null,
    }),
    [agents, tags]
  );

  function toggle(rule: Rule, next: boolean) {
    startTransition(async () => {
      const res = await setRuleEnabled(rule.id, next);
      if (res.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(next ? `“${rule.name}” is live` : `“${rule.name}” is off`, {
        tone: next ? "success" : "info",
      });
      router.refresh();
    });
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    startTransition(async () => {
      const res = await reorderRules(next.map((rule) => rule.id));
      if (res.error) {
        setOrder(order);
        toast(res.error, { tone: "error" });
        return;
      }
      router.refresh();
    });
  }

  function remove(rule: Rule) {
    startTransition(async () => {
      const res = await deleteRule(rule.id);
      setConfirmDelete(null);
      if (res.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(`Deleted “${rule.name}”`, { tone: "success" });
      router.refresh();
    });
  }

  return (
    <>
      <div className="mt-8 flex items-center justify-between gap-4">
        <p className="text-sm text-gray-600">
          {order.length} rule{order.length === 1 ? "" : "s"} ·{" "}
          {order.filter((r) => r.enabled).length} live
        </p>
        <Button variant="primary" onClick={() => setEditing({ ...EMPTY_DRAFT })}>
          New rule
        </Button>
      </div>

      {order.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">
          No rules yet. A rule can assign, tag, prioritise or auto-reply when a
          ticket arrives.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {order.map((rule, index) => (
            <li
              key={rule.id}
              className={cn(
                "rounded-xl border bg-white p-4",
                rule.enabled ? "border-gray-200" : "border-dashed border-gray-300"
              )}
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 w-5 flex-none text-caption font-semibold tabular-nums text-tertiary">
                  {index + 1}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-label font-semibold text-primary">
                      {rule.name}
                    </span>
                    <Badge tone={rule.enabled ? "success" : "neutral"} dot>
                      {rule.enabled ? "Live" : "Off"}
                    </Badge>
                    <Badge tone="info">
                      {RULE_TRIGGERS.find((t) => t.value === rule.trigger_on)?.label ??
                        rule.trigger_on}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-caption text-secondary">
                    {summarizeRule(rule, lookup)}
                  </p>
                </div>

                <div className="flex flex-none items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => move(index, -1)}
                    disabled={pending || index === 0}
                    aria-label={`Move “${rule.name}” up`}
                    title="Move up"
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => move(index, 1)}
                    disabled={pending || index === order.length - 1}
                    aria-label={`Move “${rule.name}” down`}
                    title="Move down"
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setEditing({ ...rule })}
                    disabled={pending}
                  >
                    Edit
                  </Button>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-4 border-t border-subtle pt-3">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={pending}
                    onChange={(e) => toggle(rule, e.target.checked)}
                    className="h-4 w-4 accent-brand-500"
                  />
                  <span className="text-caption text-secondary">
                    Apply this rule to new tickets
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(rule)}
                  disabled={pending}
                  className="text-caption text-tertiary hover:text-danger-text disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {editing && (
        <RuleForm
          draft={editing}
          agents={agents}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title={`Delete “${confirmDelete?.name ?? ""}”?`}
        description="Tickets it already routed keep their assignment and tags — only the rule goes."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() => confirmDelete && remove(confirmDelete)}
            >
              Delete rule
            </Button>
          </>
        }
      />
    </>
  );
}

// ------------------------------------------------------------
// The editor
// ------------------------------------------------------------

function RuleForm({
  draft: initial,
  agents,
  tags,
  onClose,
  onSaved,
}: {
  draft: RuleDraft & { id?: string };
  agents: AgentOption[];
  tags: Tag[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [testing, startTest] = useTransition();
  const [draft, setDraft] = useState<RuleDraft & { id?: string }>(initial);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);

  function patch(next: Partial<RuleDraft>) {
    setDraft((current) => ({ ...current, ...next }));
    // The preview describes the rule as it was tested, so an edit has to
    // invalidate it rather than leave a stale "would have matched 12".
    setDryRun(null);
  }

  function setCondition(index: number, condition: RuleCondition) {
    patch({
      conditions: draft.conditions.map((c, i) => (i === index ? condition : c)),
    });
  }

  function setAction(index: number, action: RuleAction) {
    patch({ actions: draft.actions.map((a, i) => (i === index ? action : a)) });
  }

  function save() {
    startTransition(async () => {
      const res = await saveRule(draft);
      if (res.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(draft.id ? "Rule saved" : "Rule created — it starts off", {
        tone: "success",
      });
      onSaved();
    });
  }

  function test() {
    startTest(async () => {
      setDryRun(await testRule(draft));
    });
  }

  const usedActionTypes = new Set(draft.actions.map((a) => a.type));
  const availableActionTypes = (Object.keys(ACTION_LABELS) as RuleActionType[]).filter(
    (type) => !usedActionTypes.has(type)
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={draft.id ? "Edit rule" : "New rule"}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={save}>
            {draft.id ? "Save rule" : "Create rule"}
          </Button>
        </>
      }
    >
      <div className="scrollbar-slim max-h-[65vh] space-y-5 overflow-y-auto pr-1">
        <div className="space-y-1.5">
          <label htmlFor="rule-name" className="block text-label text-secondary">
            Name
          </label>
          <Input
            id="rule-name"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="Order changes → Harvey"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="rule-trigger" className="block text-label text-secondary">
              Run when
            </label>
            <Select
              id="rule-trigger"
              value={draft.trigger_on}
              onChange={(e) =>
                patch({ trigger_on: e.target.value as RuleDraft["trigger_on"] })
              }
            >
              {RULE_TRIGGERS.map((trigger) => (
                <option key={trigger.value} value={trigger.value}>
                  {trigger.label}
                </option>
              ))}
            </Select>
            <p className="text-caption text-tertiary">
              {RULE_TRIGGERS.find((t) => t.value === draft.trigger_on)?.hint}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="rule-match" className="block text-label text-secondary">
              Match
            </label>
            <Select
              id="rule-match"
              value={draft.match_type}
              onChange={(e) =>
                patch({ match_type: e.target.value as RuleDraft["match_type"] })
              }
            >
              <option value="all">All of the conditions</option>
              <option value="any">Any of the conditions</option>
            </Select>
          </div>
        </div>

        {/* Conditions */}
        <section>
          <h3 className="text-label font-semibold text-primary">Conditions</h3>
          <div className="mt-2 space-y-2">
            {draft.conditions.map((condition, index) => (
              <ConditionRow
                key={index}
                condition={condition}
                tags={tags}
                onChange={(next) => setCondition(index, next)}
                onRemove={() =>
                  patch({ conditions: draft.conditions.filter((_, i) => i !== index) })
                }
              />
            ))}
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() =>
              patch({
                conditions: [...draft.conditions, defaultCondition("subject", tags)],
              })
            }
          >
            Add condition
          </Button>
        </section>

        {/* Actions */}
        <section>
          <h3 className="text-label font-semibold text-primary">Then</h3>
          <div className="mt-2 space-y-2">
            {draft.actions.map((action, index) => (
              <ActionRow
                key={index}
                action={action}
                agents={agents}
                tags={tags}
                onChange={(next) => setAction(index, next)}
                onRemove={() =>
                  patch({ actions: draft.actions.filter((_, i) => i !== index) })
                }
              />
            ))}
          </div>
          {availableActionTypes.length > 0 && (
            // Width lives on the wrapper: `cn` is a plain join, so a `w-auto`
            // on the Select would lose to the `w-full` in its base classes.
            <div className="mt-2 w-56">
              <Select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  patch({
                    actions: [
                      ...draft.actions,
                      defaultAction(e.target.value as RuleActionType),
                    ],
                  });
                }}
                aria-label="Add an action"
              >
                <option value="">Add an action…</option>
                {availableActionTypes.map((type) => (
                  <option key={type} value={type}>
                    {ACTION_LABELS[type]}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </section>

        {/* Dry run */}
        <section className="rounded-lg border border-subtle bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-label font-semibold text-primary">
                Test before enabling
              </h3>
              <p className="mt-0.5 text-caption text-tertiary">
                Checks the conditions against the last 50 tickets. Nothing is
                assigned, tagged or sent.
              </p>
            </div>
            <Button size="sm" variant="secondary" loading={testing} onClick={test}>
              Test
            </Button>
          </div>

          {dryRun && (
            <div className="mt-3 border-t border-subtle pt-3">
              {dryRun.error ? (
                <p className="text-caption text-danger-text">{dryRun.error}</p>
              ) : (
                <>
                  <p className="text-caption text-secondary">
                    Matched <strong>{dryRun.matches.length}</strong> of{" "}
                    {dryRun.checked} recent tickets.
                    {dryRun.matches.length === 0 &&
                      " Either the rule is too narrow, or nothing like this has come in lately."}
                  </p>
                  {dryRun.matches.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {dryRun.matches.slice(0, 12).map((match) => (
                        <li key={match.id} className="text-caption text-tertiary">
                          <span className="font-medium text-secondary">
                            #{match.number}
                          </span>{" "}
                          {match.subject}
                          {/* The dry run tests conditions, not outcomes. An
                              already-owned ticket would NOT have been
                              reassigned, and hiding that would overstate what
                              the rule does. */}
                          {match.assigneeId && (
                            <span className="ml-1 text-warning-text">
                              · already owned, so an assign action would have
                              skipped it
                            </span>
                          )}
                        </li>
                      ))}
                      {dryRun.matches.length > 12 && (
                        <li className="text-caption text-tertiary">
                          …and {dryRun.matches.length - 12} more
                        </li>
                      )}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function RemoveButton({ onRemove, label }: { onRemove: () => void; label: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      iconOnly
      onClick={onRemove}
      aria-label={label}
      title={label}
    >
      <XIcon size={13} />
    </Button>
  );
}

function ConditionRow({
  condition,
  tags,
  onChange,
  onRemove,
}: {
  condition: RuleCondition;
  tags: Tag[];
  onChange: (next: RuleCondition) => void;
  onRemove: () => void;
}) {
  const meta = CONDITION_FIELDS[condition.field];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Widths go on the wrappers, not the Selects: `cn` only joins, so a
          `w-auto` would sit alongside the base `w-full` and lose. */}
      <div className="w-40">
        <Select
          value={condition.field}
          // Switching field resets the operator and value: "channel contains
          // any of" is not a thing, and a stale topic value under a tag field
          // would fail validation in a way that reads as a bug.
          onChange={(e) =>
            onChange(defaultCondition(e.target.value as ConditionField, tags))
          }
          aria-label="Condition field"
        >
          {CONDITION_FIELD_KEYS.map((field) => (
            <option key={field} value={field}>
              {CONDITION_FIELDS[field].label}
            </option>
          ))}
        </Select>
      </div>

      <div className="w-40">
        <Select
          value={condition.operator}
          onChange={(e) =>
            onChange({ ...condition, operator: e.target.value as ConditionOperator })
          }
          aria-label="Condition operator"
        >
          {meta.operators.map((operator) => (
            <option key={operator} value={operator}>
              {operatorLabel(condition.field, operator)}
            </option>
          ))}
        </Select>
      </div>

      <div className="min-w-[12rem] flex-1">
        <ConditionValue condition={condition} tags={tags} onChange={onChange} />
      </div>

      <RemoveButton onRemove={onRemove} label="Remove condition" />
    </div>
  );
}

function ConditionValue({
  condition,
  tags,
  onChange,
}: {
  condition: RuleCondition;
  tags: Tag[];
  onChange: (next: RuleCondition) => void;
}) {
  const meta = CONDITION_FIELDS[condition.field];
  const set = (value: string) => onChange({ ...condition, value });

  switch (meta.valueKind) {
    case "channel":
      return (
        <Select
          value={condition.value}
          onChange={(e) => set(e.target.value)}
          aria-label="Channel"
        >
          {Object.entries(CHANNEL_META).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      );
    case "topic":
      return (
        <Select
          value={condition.value}
          onChange={(e) => set(e.target.value)}
          aria-label="Topic"
        >
          {TOPICS.map((topic) => (
            <option key={topic} value={topic}>
              {topic}
            </option>
          ))}
        </Select>
      );
    case "tag":
      return (
        <Select
          value={condition.value}
          onChange={(e) => set(e.target.value)}
          aria-label="Tag"
        >
          <option value="">Choose a tag…</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.name}>
              {tag.name}
            </option>
          ))}
        </Select>
      );
    default:
      return (
        <Input
          value={condition.value}
          onChange={(e) => set(e.target.value)}
          placeholder={meta.placeholder}
          aria-label={meta.label}
        />
      );
  }
}

function ActionRow({
  action,
  agents,
  tags,
  onChange,
  onRemove,
}: {
  action: RuleAction;
  agents: AgentOption[];
  tags: Tag[];
  onChange: (next: RuleAction) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      <span className="flex h-9 min-w-[7.5rem] items-center text-label text-secondary">
        {ACTION_LABELS[action.type]}
      </span>

      <div className="min-w-[14rem] flex-1">
        {action.type === "assign" && (
          <Select
            value={action.agent_id ?? ""}
            onChange={(e) =>
              onChange({ type: "assign", agent_id: e.target.value || null })
            }
            aria-label="Assignee"
          >
            <option value="">Choose a teammate…</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
        )}

        {action.type === "tag" && (
          <Select
            value={action.tag_id ?? ""}
            onChange={(e) => onChange({ type: "tag", tag_id: e.target.value || null })}
            aria-label="Tag to add"
          >
            <option value="">Choose a tag…</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </Select>
        )}

        {action.type === "priority" && (
          <Select
            value={action.priority}
            onChange={(e) =>
              onChange({ type: "priority", priority: e.target.value as TicketPriority })
            }
            aria-label="Priority"
          >
            {Object.entries(PRIORITY_META).map(([value, { label }]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}

        {action.type === "reply" && (
          <>
            <Textarea
              rows={4}
              maxLength={MAX_REPLY_BODY}
              value={action.body}
              onChange={(e) => onChange({ type: "reply", body: e.target.value })}
              placeholder={
                "Hi {{customer.first_name}},\n\nThanks for getting in touch — we've got this and someone will reply shortly."
              }
              aria-label="Auto-reply body"
            />
            <p className="mt-1 text-caption text-tertiary">
              Sends once, from the shared mailbox, and only if nobody has
              replied yet. The only variable available is{" "}
              <code className="font-mono text-mono">
                {"{{customer.first_name}}"}
              </code>{" "}
              — order variables are refused, because nothing reviews an
              automatic send before it goes.
            </p>
          </>
        )}
      </div>

      <RemoveButton onRemove={onRemove} label={`Remove ${ACTION_LABELS[action.type]}`} />
    </div>
  );
}
