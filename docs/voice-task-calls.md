# One-off AI voice task calls

Ops and administrators can open **Flights → AI voice calls** to use the
AI Voicebot control center without attaching a call to a trip.

## Menu

- **New call** — destination number, scoped task, immediate call action
- **Active** — dialing/in-progress calls, partial transcript, live listen
- **History** — outcome, transcript recovery, recording playback, `.txt` log,
  retry, and delete

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

## Transcription and recording reliability

Every one-off call explicitly configures:

- Deepgram Nova-2 English transcription with Skyway/aviation keyword hints
- transcript, conversation-update, status-update, and end-of-call-report
  server messages
- the Skyway webhook URL and authenticated `X-Vapi-Secret` header
- full message history and transcript artifacts
- mono call recording and live monitoring
- exponential webhook delivery retries

Final transcript events are accumulated while the call is active. The full
end-of-call artifact replaces or extends that partial log. If Vapi ends a call
before artifacts are ready, the job remains marked **Transcript pending** and
Skyway automatically retries artifact retrieval. Ops can also select
**Refresh transcript** to query Vapi immediately.

Recording playback requests a fresh short-lived authenticated URL from Vapi;
recording URLs and Vapi call IDs are never exposed in stored public summaries.

## History actions

- **Download .txt** preserves the assigned task and all returned responses.
- **Retry** starts a new call with the same number and task and links it to the
  original.
- **Delete** is available only for finished calls and retains a deletion audit
  event. Active calls cannot be deleted.

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

