// Validates a layered render plan against plan.schema.json, plus the rules a schema cannot express (one box per
// frame, takes inside the timeline and not overlapping). No dependency: a small validator for the subset of JSON
// Schema the plan schema uses (type, required, properties, additionalProperties, items, prefixItems, min/maxItems,
// minimum, exclusiveMinimum, minLength, pattern, local $ref).
import { readFileSync } from "node:fs";

export const PLAN_SCHEMA = JSON.parse(readFileSync(new URL("./plan.schema.json", import.meta.url), "utf8"));

const typeOk = (t, v) =>
  t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v)
  : t === "array" ? Array.isArray(v)
  : t === "integer" ? Number.isInteger(v)
  : t === "number" ? typeof v === "number" && Number.isFinite(v)
  : t === "string" ? typeof v === "string"
  : t === "boolean" ? typeof v === "boolean"
  : false;

/**
 * Validates `value` against a JSON Schema (the subset above).
 * @returns {string[]} errors, as "path: message"
 */
export const validateSchema = (schema, value, root = schema, path = "$") => {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], root);
    if (!target) return [`${path}: unresolved $ref ${schema.$ref}`];
    return validateSchema(target, value, root, path);
  }
  const errors = [];
  if (schema.type && !typeOk(schema.type, value)) return [`${path}: expected ${schema.type}`];
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(`${path}: must be > ${schema.exclusiveMinimum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    const prefix = schema.prefixItems ?? [];
    value.forEach((x, i) => {
      const s = i < prefix.length ? prefix[i] : schema.items;
      if (s) errors.push(...validateSchema(s, x, root, `${path}[${i}]`));
    });
  }
  if (typeOk("object", value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${path}: missing ${k}`);
    for (const [k, x] of Object.entries(value)) {
      const s = schema.properties?.[k];
      if (s) errors.push(...validateSchema(s, x, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unknown property ${k}`);
    }
  }
  return errors;
};

/**
 * Validates a plan: schema first, then the per-frame and timeline rules.
 * @returns {string[]} errors (empty when valid)
 */
export const validatePlan = (plan) => {
  const errors = validateSchema(PLAN_SCHEMA, plan);
  if (errors.length) return errors;
  if (plan.width % 2 || plan.height % 2) errors.push("$: width and height must be even (yuv420p)");
  const takes = [...plan.takes].map((t, i) => ({ ...t, i })).sort((a, b) => a.start - b.start);
  let end = 0;
  for (const t of takes) {
    const p = `$.takes[${t.i}]`;
    if (t.box.length !== t.frames) errors.push(`${p}: box has ${t.box.length} entries, expected one per frame (${t.frames})`);
    if (t.video.length !== t.frames) errors.push(`${p}: video has ${t.video.length} entries, expected one per frame (${t.frames})`);
    if (t.start + t.frames > plan.frames) errors.push(`${p}: ends at frame ${t.start + t.frames}, after the timeline (${plan.frames})`);
    if (t.start < end) errors.push(`${p}: overlaps the previous take (one take on screen at a time)`);
    end = Math.max(end, t.start + t.frames);
  }
  (plan.audio ?? []).forEach((a, i) => {
    if (a.fadeOut && a.fadeOut[1] < a.fadeOut[0]) errors.push(`$.audio[${i}].fadeOut: end before start`);
  });
  return errors;
};

/** Throws with every error if the plan is not valid. */
export const assertPlan = (plan) => {
  const errors = validatePlan(plan);
  if (errors.length) throw new Error(`invalid plan:\n  ${errors.slice(0, 20).join("\n  ")}`);
  return plan;
};
