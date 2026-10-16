# `ask_user_question` wire shape — what a remote client must send to answer `user-questions/request`

Investigated 2026-10-14 by teammate `ask-shape`. asar root = `D:\DSH\resources\app.asar`.
Everything below is either quoted from shipped code or observed on a live round-trip.

---

## 0. TL;DR — the `value` payload

```js
api.callRaw('$events/result', {
  clientId,                       // from the `{type:'ready'}` frame of THIS open `$events` stream
  eventId,                        // from the waterfall frame
  outcome: { kind: 'result', value: { answers: [ /* one item per question */ ] } },
});
```

Each answer item has **exactly three allowed keys**: `id`, `selected`, `custom?`.

| case | `value` |
|---|---|
| (a) single-select | `{"answers":[{"id":"probe_multi","selected":["blue"]}]}` |
| (b) multi-select | `{"answers":[{"id":"probe_multi","selected":["red","green"]}]}` |
| (c) free text / "other" | `{"answers":[{"id":"probe_free","selected":[],"custom":"typed-word-42"}]}` |
| (d) skip / abstain (this question) | `{"answers":[{"id":"probe_free","selected":[]}]}` |
| (e) refuse / cancel the event | `{"clientId":…,"eventId":…,"outcome":{"kind":"rejected","error":"…"}}` |

There is **no per-question `multiSelect` echo, no `callId`, no `label`** in the answer — only `answers[].id`.

Success response is literally `{"ok":true}` (the RPC returns `{ ok: true, value: undefined }`).

---

## 1. Validating code, field by field

### `value` = `{ answers: [...] }` — tool output schema (authoritative)
`app.asar\dsh\node_modules\@deepseek-ai\dsh-tool-ask-user\lib\index.js`

```js
output: { schema: { type: "object", additionalProperties: false, properties: {
  answers: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
    id:       { type: "string", required: true },
    selected: { type: "array", required: true, items: { type: "string" } },
    custom:   { type: "string" },
  } } } } },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] }
```
`additionalProperties: false` ⇒ exactly those three keys. `selected` is **required** and must be an array
(send `[]`, never omit it, never send a bare string). The `render` emitting `JSON.stringify(value)` is why the
logged tool result is byte-identical to what you sent (proved in §3).

### Same shape on the service/RPC side
`dsh-user-questions\lib\typert.host.js`:
```js
const _deepseek_ai_dsh_user_questions_userQuestions_answer_parameter_2$schema = () => (… ??= z.object({
  'answers': z.array(z.object({
    'id': z.string(),
    'selected': z.array(z.string()),
    'custom': z.string().optional(),
  })),
}))
```
`dsh-user-questions\lib\types\projection.js` (strict mirror used by the projection fold):
```js
const answerSchema = z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() }).strict()…
const answerBatchSchema = z.object({ answers: z.array(answerSchema) }).loose();
```

### Shipped renderer composition (why `custom` empties `selected`)
`dsh-client-ui-user-questions\lib\client.js`, `submitDrafts`:
```js
if (value.skipped) return { id: item.id, selected: [] };
const custom = value.custom.trim();
return { id: item.id,
  selected: custom === "" || item.multiSelect === true ? value.selected : [],
  ...(custom === "" ? {} : { custom }) };
```
For a **single-select** with non-blank custom text the desktop UI deliberately sends `selected: []` and only `custom`;
for a **multi-select** it sends both. The schema permits `selected` + `custom` together on any question, so a phone
may send both — only the desktop's own UI is that strict.

### `outcome` envelope — the wire validator
`dsh-api-gateway\lib\types\stream-protocol.js`, `parseRemoteEventResult`:
```js
if (!isRecord(value) || !exactKeys(value, ['clientId','eventId','outcome'])
    || !isRemoteEventClientId(value.clientId) || !isRemoteEventId(value.eventId)
    || !isRecord(value.outcome)) throw new Error('api gateway: invalid Remote event result');
```
Accepted `outcome` variants: `{kind:'next'}`, `{kind:'result'}`, `{kind:'result', value}` (with `isRemoteJsonValue(value)`),
`{kind:'rejected', error}`. Anything else → the `invalid Remote event result` throw.
`parseRemoteEventResultPayload` additionally requires the RPC payload to be exactly one plain-object `args` field —
`DesktopApi.callRaw(endpoint, args)` already wraps it as `{type:'client-request', rpcId, method, payload:{args}}`, so
**pass the object above directly to `callRaw` and do not add a `request` wrapper**.

### Dispatch / success response
`dsh-api-gateway\lib\types\index.js`:
```js
if (endpoint === REMOTE_EVENT_RESULT_ENDPOINT) {
  try { const result = parseRemoteEventResultPayload(payload);
        const client = this.remoteEventClients.get(result.clientId);
        if (client === undefined) throw new Error('typert gateway: Remote event result identifies no active event stream');
        this.receiveRemoteEventResult(client, result);
        return { ok: true, value: undefined }; }
  catch (error) { return rpcFailure(error); } }
```
`receiveRemoteEventResult` is an **idempotent no-op** unless `pending.deliveries.has(client)`, and on
`kind:'result'` it calls `settleRemoteEvent(pending, {kind:'result', value: outcome.value})` →
`pending.source.resolve(outcome)`. `dsh-api-remotes\lib\index.js` `forwardWaterfall` then does
`resolve: (outcome) => { if (outcome.kind === 'result') { settled.resolve(outcome.value); return; } … }` —
`outcome.value` is returned to the tool **verbatim and unvalidated**.

### One deliberate asymmetry to know
`dsh-user-questions\lib\types\index.js`, `answer(agent, callId, answer)` — the *RPC* answer channel — enforces:
```js
const answered = new Set(answer.answers.map(item => item.id));
if (answered.size !== answer.answers.length
    || question.questions.length !== answer.answers.length
    || !question.questions.every(item => answered.has(item.id)))
  throw new UserQuestionError(`the answer batch for ${callId} must name each of its ${…} questions exactly once`, 'BAD_ANSWER');
```
The `$events/result` waterfall path does **not** enforce this. Send one item per question anyway — it is the
model-facing contract and the only thing that works on both channels. (Other codes: `REPLY_QUEUED`,
`CALLER_NOT_LIVE`, `DELEGATED_CALLER`, `NO_PROVIDER`, `EMPTY_QUESTIONS`, `DUPLICATE_WAIT`.)

**Gotcha that will bite a phone client**: the tool consumes the batch as
`selected: [...answer.selected]`. A bare string `"blue"` is iterable, so it silently becomes
`["b","l","u","e"]` — no error. Always send an array.

---

## 2. Question schema the phone must render

Forwarded frame (observed live):
```json
{"type":"waterfall","event":"user-questions/request","eventId":"007475d3-…","agentId":"session-…",
 "request":{"questions":[
   {"id":"probe_multi","question":"Probe: pick colours","header":"Probe",
    "options":[{"label":"red"},{"label":"blue"},{"label":"green"}],"multiSelect":true},
   {"id":"probe_free","question":"Probe: type a word","header":"Probe"}]}}
```
Service vocabulary (`projection.js` `questionSchema`, `.strict()`):
`{ id: string, question: string, detail?: string, header?: string, options?: [{label: string, description?: string}], multiSelect?: boolean }`
plus optional `intent: {kind, approve}` (with `detail` required; `ask()` throws `BAD_INTENT` unless `intent.approve`
names one of the question's own option labels).

- **`id`** — required, unique per batch. Echo it back verbatim in `answers[].id`. This is the ONLY identity the phone echoes.
- **`question`** — required, the prompt text.
- **`header`** — optional short title. **`detail`** — optional long body.
- **`options[]`** — optional. `label` required (echo labels into `selected`); `description` optional sub-text.
  **A question with no `options` key is the free-text case** (see `probe_free` above) — render a text box feeding `custom`.
- **`multiSelect`** — optional boolean, **absent when false**. Present here as service spelling.

**Naming delta to watch**: the model/tool-args layer spells it `multi_select`; the service request and the
forwarded `request.questions[]` frame spell it `multiSelect`. Observed live in the tool call args as
`"multi_select": true` and in the very same request's frame as `"multiSelect": true`.

**Identity**: only `answers[].id`. `callId` appears at `request.wait?.callId` and matters only for the RPC path /
timed questions — not for `$events/result`. `eventId` + `clientId` correlate the reply to the pending event.
A fresh `$events` subscriber is re-delivered still-pending events on connect, so a phone can attach late and still answer.

### Timeout / pending semantics (timed variant only)
The tool takes an optional `timeout` (int, `-1` or `1..2147483`, default 120 s). On expiry it returns a **pending**
result, not a skip — output `{ pending: true, callId, message }`, where `message` begins
"No answer batch arrived before the timeout. This is pending, not a skipped answer. …". The late answer then arrives
as a *user message* with `source: {kind:'user-question-reply', callId, outcome:'answered'}` whose text is
`JSON.stringify({kind:'answer_to_pending_question', tool:'ask_user_question', callId, questions, answers})` —
the same `answers` shape. Renderer errors to surface: `ASK_ABORTED`, `ASK_CANCELLED`, `ASK_TIMED_OUT`.

---

## 3. Live round-trip evidence against the running desktop runtime

### Round-trip #1 — single-select
Script `D:\Workspace\dsh_android\.probe\events-ask-roundtrip.mjs` (keeps the `$events` generator OPEN while sending —
closing it first yields `typert gateway: Remote event result identifies no active event stream`).

```
READY clientId = cf8d5d2a-cbc3-4c68-9ead-2a7678cd21a3
FRAME: {"type":"waterfall","event":"user-questions/request","eventId":"4179fb89-3432-4abc-ab04-ebd4e9db6081",
        "agentId":"session-8129a74b-adf0-40b3-989a-20e2405693de",
        "request":{"questions":[{"id":"probe_colour","question":"Probe: pick a colour","header":"Probe",
        "options":[{"label":"red"},{"label":"blue"}]}]}}
SENDING value = {"answers":[{"id":"probe_colour","selected":["blue"]}]}
RAW RESPONSE  = {"ok":true}
```
Transcript `C:\Users\Administrator\.dsh\sessions\--D-Workspace-dsh_android--\session-8129a74b-…\session.v4.jsonl.zstd`:
- seq 20 `tool/call` `call_00_ET_adEnrT5wkqNs3P8GTYeE3208` `ask_user_question`
- seq 21 `tool/result` `{"answers":[{"id":"probe_colour","selected":["blue"]}]}` `isError:false`
- seq 25 `assistant/message` — **`Answer received: **blue**. Stopping here as instructed.`**

### Round-trip #2 — multi-select **and** free-text `custom` in one batch
Script `D:\Workspace\dsh_android\.probe\events-ask-roundtrip2.mjs`, fresh session `session-ff7b807b-f63b-4e67-b4db-89ce015d4aaa`.

```
READY clientId = c255562e-a187-47bc-a82a-1f272b052bc5
FRAME: {"type":"waterfall","event":"user-questions/request","eventId":"007475d3-2e39-424d-b289-c8dc52ca1a7e",
 "agentId":"session-ff7b807b-f63b-4e67-b4db-89ce015d4aaa",
 "request":{"questions":[
   {"id":"probe_multi","question":"Probe: pick colours","header":"Probe",
    "options":[{"label":"red"},{"label":"blue"},{"label":"green"}],"multiSelect":true},
   {"id":"probe_free","question":"Probe: type a word","header":"Probe"}]}}
SENDING value = {"answers":[{"id":"probe_multi","selected":["red","green"]},
                            {"id":"probe_free","selected":[],"custom":"typed-word-42"}]}
RAW RESPONSE  = {"ok":true}
```
Transcript (same directory, `session-ff7b807b-…\session.v4.jsonl.zstd`, 12 zstd frames / 30 records):
- seq 19 `tool/call` `call_00_ET_9MSp0hdOIATqCSMBEH5h4038` `ask_user_question`
  arguments `{"questions": [{"id": "probe_multi", …, "multi_select": true, …}, {"id": "probe_free", …}]}`
- seq 21 `tool/result` `isError:false` `content[0].text`:
  `{"answers":[{"id":"probe_multi","selected":["red","green"]},{"id":"probe_free","selected":[],"custom":"typed-word-42"}]}`
  — **byte-identical** to the value sent.
- seq 25 `assistant/message` step 2 text: `DONE`; seq 28 `turn/end` `{kind:'completed'}`.

Read-path check a phone would use: `api.callRaw('session/page', { request: { address:{kind:'session',sessionId},
throughSeq: 28, maxMessages: 60 } })` → `ok:true`, contains `typed-word-42` and the tool result above.
(`throughSeq` is required and must be ≤ the session cursor: `MAX_SAFE_INTEGER` → `session page through seq … is
past cursor 28`; omitting it fails boundary validation.)

**No answer was rejected in either round-trip.** Every send returned `{"ok":true}` and landed unmodified in the
tool result, which the model then read (both follow-up assistant messages quote the answer).

---

## 4. Second answer channel (for timed/pending questions only)

RPC `userQuestions/answer(agent, callId, answer)` → `z.boolean()`, scope `{context:'agent', wire:'agentId'}`,
wire params `{ agentId, callId, answer }` where `answer` is the same `{answers:[{id,selected,custom?}]}`.
Returns `false` when the call is not continued; throws `BAD_ANSWER` if the batch does not name each question exactly once.
Suitable for answering a question whose 120 s foreground wait already expired — the late reply is steered in as a
user message. For a live pending watermark, use `$events/result` instead: it resolves the tool call in place.

---

## 5. Phone-client checklist

1. Open `$events` and keep the generator alive for the whole session; grab `clientId` from the `ready` frame.
2. On `{type:'waterfall', event:'user-questions/request'}` render `request.questions[]`.
3. Per question build `{ id, selected: string[], custom?: string }` — always an array, always include `selected`.
4. Send `{clientId, eventId, outcome:{kind:'result', value:{answers}}}` — one item per question, ids echoing the request.
5. Expect `{"ok":true}`. Use `outcome:{kind:'rejected', error}` only to refuse the whole event.
6. Do not abort the `$events` stream before the reply lands, or you get
   `typert gateway: Remote event result identifies no active event stream`.

Raw evidence JSON: `D:\Workspace\dsh_android\.probe\events-ask-roundtrip2.json`, `page2.json`, `transcript2b.jsonl`.
