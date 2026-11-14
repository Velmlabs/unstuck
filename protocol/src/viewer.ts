import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const SessionStatusSchema = Type.Union(
  ['created', 'notifying', 'waiting', 'active', 'resolved', 'timed_out', 'cancelled', 'failed'].map((s) => Type.Literal(s)),
);
export type SessionStatus = 'created' | 'notifying' | 'waiting' | 'active' | 'resolved' | 'timed_out' | 'cancelled' | 'failed';

const Num = Type.Number();
const Lit = <T extends string>(v: T) => Type.Literal(v);

export const ViewerToEngineSchema = Type.Union([
  Type.Object(
    { t: Lit('hello'), token: Type.String(), resumeKey: Type.Optional(Type.String()), code: Type.Optional(Type.String({ pattern: '^[0-9]{6}$' })) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      t: Lit('mouse'),
      action: Type.Union([Lit('down'), Lit('up'), Lit('move')]),
      x: Num,
      y: Num,
      button: Type.Union([Lit('left'), Lit('right'), Lit('middle'), Lit('none')]),
      clickCount: Num,
      modifiers: Num,
    },
    { additionalProperties: false },
  ),
  Type.Object({ t: Lit('wheel'), x: Num, y: Num, dx: Num, dy: Num }, { additionalProperties: false }),
  Type.Object(
    {
      t: Lit('key'),
      action: Type.Union([Lit('down'), Lit('up')]),
      key: Type.String(),
      code: Type.String(),
      text: Type.Optional(Type.String()),
      modifiers: Num,
    },
    { additionalProperties: false },
  ),
  Type.Object({ t: Lit('text'), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ t: Lit('done') }, { additionalProperties: false }),
  Type.Object({ t: Lit('cant_solve'), reason: Type.Optional(Type.String({ maxLength: 200 })) }, { additionalProperties: false }),
  Type.Object({ t: Lit('ping') }, { additionalProperties: false }),
]);
export type ViewerToEngine = Static<typeof ViewerToEngineSchema>;
export type ViewerInput = Extract<ViewerToEngine, { t: 'mouse' | 'wheel' | 'key' | 'text' }>;

export const ViewerErrorCodes = ['token_invalid', 'token_used', 'expired', 'session_closed', 'bad_message', 'code_required', 'code_invalid'] as const;
export type ViewerErrorCode = (typeof ViewerErrorCodes)[number];

/** What kind of field the person can type into, so the viewer can open the matching keyboard (never its value). */
export const FieldKinds = ['text', 'numeric', 'otp', 'email', 'password'] as const;
export type FieldKind = (typeof FieldKinds)[number];
const FieldKindSchema = Type.Union(FieldKinds.map((k) => Lit(k)));
/** A typable field's box in CSS pixels of the streamed viewport (the same space as `mouse` messages). */
export const FieldSchema = Type.Object({ x: Num, y: Num, w: Num, h: Num, kind: FieldKindSchema }, { additionalProperties: false });
export type Field = Static<typeof FieldSchema>;

export const EngineToViewerSchema = Type.Union([
  Type.Object({ t: Lit('ready'), reason: Type.String(), site: Type.String(), expiresAt: Num, resumeKey: Type.String() }),
  Type.Object({ t: Lit('state'), status: SessionStatusSchema }),
  Type.Object({ t: Lit('error'), code: Type.Union(ViewerErrorCodes.map((c) => Lit(c))), message: Type.String() }),
  Type.Object({ t: Lit('pong') }),
  Type.Object({ t: Lit('fields'), fields: Type.Array(FieldSchema, { maxItems: 30 }) }),
  Type.Object({ t: Lit('focus'), kind: Type.Union([FieldKindSchema, Type.Null()]), field: Type.Optional(FieldSchema) }),
]);
export type EngineToViewer =
  | { t: 'ready'; reason: string; site: string; expiresAt: number; resumeKey: string }
  | { t: 'state'; status: SessionStatus }
  | { t: 'error'; code: ViewerErrorCode; message: string }
  | { t: 'pong' }
  | { t: 'fields'; fields: Field[] }
  /** `field`: where the focused field is (engine 0.1.3+), so the viewer can outline it; never its value. */
  | { t: 'focus'; kind: FieldKind | null; field?: Field };

export function parseViewerMessage(raw: string): ViewerToEngine | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  return Value.Check(ViewerToEngineSchema, v) ? (v as ViewerToEngine) : null;
}

/**
 * How long a human who left the viewer (switched apps to read a code, lost signal) can come back and resume.
 * The engine frees the agent after this; the viewer stops retrying after it.
 */
export const RESUME_WINDOW_MS = 5 * 60_000;
