# `vendor.myndhyve.kanban`

MyndHyve kanban-coordination pack. 6 nodes covering board lifecycle, task management, timeline planning, automation, and resource monitoring.

| Pack | `vendor.myndhyve.kanban` |
| peerDependencies | `host.kanban: supported` |

## Nodes (typeId-preserve)

| typeId | role |
|---|---|
| `kanban.board.create` | side-effect |
| `kanban.board.review` | side-effect (read with summary) |
| `kanban.task.assign` | side-effect |
| `kanban.timeline.plan` | side-effect (compute) |
| `kanban.workflow.automate` | side-effect |
| `kanban.resource.monitor` | side-effect (read) |

All side-effectful + cacheable. Engine Layer-2 cache covers replay cost-once.

## Workflow automate rule shapes

| Trigger | Action |
|---|---|
| `column-transition` | `assign`, `move-column`, `set-label`, `send-notification`, `invoke-workflow` |
| `due-date-approaching` | (same set) |
| `label-changed` | (same set) |
| `assignee-changed` | (same set) |

Closed enums on type fields; payload shape is rule-specific (allowed per `additionalProperties: true` on each).

## Host contract

```typescript
ctx.kanban.boardCreate({ name, columns, description?, projectId?, idempotencyKey })
  → Promise<{ boardId, createdAt }>

ctx.kanban.boardReview({ boardId, includeArchived, atRiskThresholdDays })
  → Promise<{ boardName?, totalTasks, columnCounts, atRiskTasks, reviewedAt? }>

ctx.kanban.taskAssign({ taskId, assigneeId, notifyAssignee, comment?, idempotencyKey })
  → Promise<{ previousAssigneeId?, assignedAt? }>

ctx.kanban.taskGet(taskId) → Promise<TaskDetail>            // optional accessor
ctx.kanban.taskCreateBatch({ parentTaskId, subtasks, idempotencyKey })
  → Promise<{ subtaskIds: string[] }>                        // optional, used when createOnBoard=true

ctx.kanban.timelinePlan({ boardId, scheduler, ... })
  → Promise<{ schedule, criticalPath, projectEndDate? }>

ctx.kanban.automateRules({ boardId, rules, replaceExisting, idempotencyKey })
  → Promise<{ activeRules, added, appliedAt? }>
  // A host without a durable workflow binding rejects with
  // `{ code: 'kanban_automation_unavailable' }`; a pack never creates an
  // in-memory runner as a substitute.

ctx.kanban.resourceMonitor({ boardId, maxConcurrentPerAssignee, includeAgents })
  → Promise<{ assigneeLoad, wipBreaches, overdueTasks, monitoredAt? }>

```

## See also

- [`docs/plans/MYNDHYVE-TO-OPENWOP-PACK-MIGRATION.md`](https://github.com/openwop/openwop) (in myndhyve)
