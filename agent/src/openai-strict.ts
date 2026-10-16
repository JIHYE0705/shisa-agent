// OpenAI 구조화 출력(strict: true)용 스키마 변환과 그 반대(답에서 덧붙인 null 빼기).
// strict 는 모든 객체에 additionalProperties:false, properties 의 키를 전부 required 로 요구한다(중첩까지).
// 선택 필드는 null 을 허용하는 꼴로 바꾸고, 답의 그 null 은 원래 스키마를 보고 지운다 → Gemini·Claude 와 같은 모양.
// 출처: https://platform.openai.com/docs/guides/structured-outputs#supported-schemas
// Gemini·Claude 는 원래 스키마 그대로 보낸다(여기는 OpenAI 경로에서만 쓴다).

type Json = Record<string, unknown>;

// strict 에서 그대로 두는 키워드. 그 밖(minimum·maximum·minLength·pattern·format 등)은 OpenAI 사본에서만 뺀다
export const STRICT_KEYWORDS = new Set([
  "type", "description", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "$defs", "$ref",
]);
const SIMPLE = new Set(["string", "number", "integer", "boolean"]);

const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

// 이 스키마가 null 을 이미 받나
export function allowsNull(s: unknown): boolean {
  if (!isObj(s)) return false;
  if (s.type === "null" || (Array.isArray(s.type) && s.type.includes("null"))) return true;
  if (s.const === null || (Array.isArray(s.enum) && s.enum.includes(null))) return true;
  for (const k of ["anyOf", "oneOf"] as const) if (Array.isArray(s[k]) && (s[k] as unknown[]).some(allowsNull)) return true;
  return false;
}

const hasString = (s: unknown): boolean =>
  isObj(s) && (s.type === "string" || (Array.isArray(s.type) && s.type.includes("string")) || (Array.isArray(s.anyOf) && s.anyOf.some(hasString)));

// 선택 필드를 null 도 받게. 간단한 타입은 type:[t,"null"](enum 이면 null 도 넣는다), 나머지는 anyOf 에 null 을 더한다
function nullable(s: Json): Json {
  if (allowsNull(s)) return s;
  if (typeof s.type === "string" && SIMPLE.has(s.type) && !s.anyOf) {
    return { ...s, type: [s.type, "null"], ...(Array.isArray(s.enum) ? { enum: [...s.enum, null] } : {}) };
  }
  if (Array.isArray(s.anyOf)) return { ...s, anyOf: [...s.anyOf, { type: "null" }] };
  const { description, ...rest } = s;
  return { anyOf: [rest, { type: "null" }], ...(description !== undefined ? { description } : {}) };
}

function convert(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(convert);
  if (!isObj(s)) return s;
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    const key = k === "oneOf" ? "anyOf" : k; // strict 는 oneOf 를 모른다 → anyOf
    if (!STRICT_KEYWORDS.has(key)) continue;
    if (key === "properties" && isObj(v)) {
      const req = new Set(Array.isArray(s.required) ? s.required as string[] : []);
      const props: Json = {};
      for (const [pk, pv] of Object.entries(v)) {
        let c = convert(pv) as Json;
        if (!req.has(pk) && isObj(c)) {
          // 원래 null 이 '지우기' 뜻인 선택 필드: 이제 늘 채워야 하니 '그대로'는 빈 문자열로(todos.ts opPatch 가 빈 문자열은 안 바꾼다)
          if (allowsNull(pv) && hasString(pv)) c = { ...c, description: `${typeof c.description === "string" ? `${c.description} ` : ""}그대로 두려면 빈 문자열.` };
          c = nullable(c);
        }
        props[pk] = c;
      }
      out.properties = props;
    } else if (key === "$defs" && isObj(v)) {
      out.$defs = Object.fromEntries(Object.entries(v).map(([dk, dv]) => [dk, convert(dv)]));
    } else if (key === "required" || key === "enum" || key === "const") {
      out[key] = v;
    } else {
      out[key] = convert(v);
    }
  }
  const isObject = s.type === "object" || (Array.isArray(s.type) && s.type.includes("object")) || isObj(s.properties);
  if (isObject) {
    out.properties ??= {};
    out.required = Object.keys(out.properties as Json);
    out.additionalProperties = false;
  }
  return out;
}

// 원래 스키마를 바꾸지 않고 strict 사본을 만든다
export function toOpenAiStrict<T = unknown>(schema: T): T {
  return convert(JSON.parse(JSON.stringify(schema))) as T;
}

function resolveRef(s: Json, root: unknown): Json {
  if (typeof s.$ref !== "string" || !isObj(root)) return s;
  const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
  const d = m && isObj(root.$defs) ? (root.$defs as Json)[m[1]] : undefined;
  return isObj(d) ? d : s;
}

const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
function fits(s: unknown, v: unknown): boolean {
  if (!isObj(s)) return false;
  const k = kindOf(v);
  const ts = Array.isArray(s.type) ? s.type : s.type !== undefined ? [s.type] : isObj(s.properties) ? ["object"] : [];
  return ts.includes(k) || (k === "integer" && ts.includes("number"));
}

// OpenAI 답에서 toOpenAiStrict 가 덧붙인 null 만 뺀다: 원래 선택 필드이고 원래 null 을 안 받던 키.
// 원래 스키마가 null 을 받는 필드(todo_ops 의 link·note = 지우기)는 그대로 둔다
export function stripAddedNulls(value: unknown, schema: unknown, root: unknown = schema): unknown {
  if (!isObj(schema)) return value;
  const s = resolveRef(schema, root);
  const alts = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined) as unknown[] | undefined;
  if (alts) {
    const pick = alts.map((a) => (isObj(a) ? resolveRef(a, root) : a)).find((a) => fits(a, value));
    return pick ? stripAddedNulls(value, pick, root) : value;
  }
  if (Array.isArray(value)) return isObj(s.items) ? value.map((x) => stripAddedNulls(x, s.items, root)) : value;
  if (isObj(value) && isObj(s.properties)) {
    const props = s.properties as Json;
    const req = new Set(Array.isArray(s.required) ? s.required as string[] : []);
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      const ps = props[k];
      if (v === null && ps !== undefined && !req.has(k) && !allowsNull(isObj(ps) ? resolveRef(ps, root) : ps)) continue;
      out[k] = ps === undefined ? v : stripAddedNulls(v, ps, root);
    }
    return out;
  }
  return value;
}
