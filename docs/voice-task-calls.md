# One-off AI voice task calls

Ops and administrators can open **Flights → AI voice calls** and create a
one-off business call without attaching it to a trip.

## Workflow

1. Enter the destination phone number.
2. Describe one precise task, including only the facts and authority the agent
   needs.
3. Select **Call now and complete task**.
4. Skyway places the call immediately through Vapi and Twilio.
5. When Vapi returns the end-of-call report, Skyway stores the status,
   structured task outcome, summary, and exact transcript.
6. Select **Download .txt** to save a text log containing the assigned task,
   completion result, follow-up requirement, notes, and transcript.

One-off jobs are stored in `voice-task-calls`. They are deliberately separate
from `fbo-call-jobs`: they do not affect trip readiness, FBO scheduling, the
five-minute FBO cron, trip-state mirrors, or broker tracking links.

## Agent boundaries

- Ops/admin authorization is required to place and view calls.
- The agent identifies itself and discloses recording.
- It completes only the entered task and asks one question at a time.
- It does not invent confirmations or treat vague answers as completion.
- It does not authorize charges, provide payment data, negotiate contracts, or
  handle emergency, legal, medical, security, or customs decisions.
- Human requests and out-of-scope decisions transfer to Skyway operations.

## Vapi webhook

The existing webhook handles both call types. One-off calls include:

```json
{
  "skywayCallId": "vtask_...",
  "skywayJobKind": "voice_task"
}
```

The discriminator routes events to `voice-task-calls` and
`voice-task-call-events`. Older FBO calls without a discriminator continue to
route to `fbo-call-jobs`.

