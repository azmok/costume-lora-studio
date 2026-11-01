import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCaption, dedupeTags, hasTag, removeTag, BUILTIN_TEMPLATES, insertTags, upsertTemplate, removeTemplate, readTemplateStore, serializeTemplateStore, normalizeTemplateName, splitTags } from "../tools-captions.mjs";

test("tags go right after the trigger word and existing tags are kept", () => {
  assert.equal(insertTags("buruburu, bloomer, from behind", "buruburu", "gym uniform, outdoors"), "buruburu, gym uniform, outdoors, bloomer, from behind");
});

test("duplicates are skipped case-insensitively and the trigger is not repeated", () => {
  assert.equal(insertTags("buruburu, Bloomer", "buruburu", "bloomer, BURUBURU, navy"), "buruburu, navy, Bloomer");
});

test("captions without a trigger get one first; empty captions become trigger + tags", () => {
  assert.equal(insertTags("bloomer, close-up", "buruburu", "navy"), "buruburu, navy, bloomer, close-up");
  assert.equal(insertTags("", "buruburu", "navy, navy"), "buruburu, navy");
  assert.equal(insertTags("", "", "navy"), "navy");
});

test("inserting nothing only normalizes the trigger position", () => {
  assert.equal(insertTags("a, buruburu, b", "buruburu", "  , "), "buruburu, a, b");
  assert.deepEqual(splitTags("a、b,\n c , a"), ["a", "b", "c"]);
});

test("built-in templates include the SD1.5 tag template and reserve their names", () => {
  const tag = BUILTIN_TEMPLATES.find((template) => template.id === "sd15-clothing-tags");
  assert.match(tag.prompt, /Danbooru/);
  assert.match(tag.prompt, /comma-separated tags/);
  assert.match(tag.name, /masked/);
  assert.match(tag.prompt, /masked, absent, or irrelevant/);
  assert.match(tag.prompt, /Output ONLY the lowercase, comma-separated tags/);
  assert.throws(() => normalizeTemplateName(tag.name));
});

test("character LoRA templates are built in with unique ids and names", () => {
  const tags = BUILTIN_TEMPLATES.find((template) => template.id === "sd15-character-tags");
  const prose = BUILTIN_TEMPLATES.find((template) => template.id === "modern-character-sentence");
  assert.match(tags.prompt, /character LoRA training/);
  assert.match(tags.prompt, /VARIABLE ELEMENTS/);
  assert.match(prose.prompt, /Flux and SD3/);
  assert.match(prose.prompt, /2 to 4 sentences/);
  assert.equal(new Set(BUILTIN_TEMPLATES.map((template) => template.id)).size, BUILTIN_TEMPLATES.length);
  assert.equal(new Set(BUILTIN_TEMPLATES.map((template) => template.name)).size, BUILTIN_TEMPLATES.length);
  assert.ok(BUILTIN_TEMPLATES.every((template) => template.prompt.trim() && template.prompt.length <= 4000));
});

test("custom templates are saved by name, overwritten, removed and validated", () => {
  let templates = upsertTemplate([], "mine", "Describe the outfit.", false);
  templates = upsertTemplate(templates, "mine", "Describe the outfit only.", true);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].prompt, "Describe the outfit only.");
  assert.deepEqual(removeTemplate(templates, "mine"), []);
  assert.throws(() => upsertTemplate([], "x", "   "));
  assert.throws(() => upsertTemplate([], "x", "a".repeat(4001)));
  const raw = JSON.stringify({ schema_version: 1, templates: [{ name: "ok", prompt: "p" }, { name: "bad", prompt: "" }] });
  assert.deepEqual(readTemplateStore(raw).map((template) => template.name), ["ok"]);
  assert.deepEqual(readTemplateStore(serializeTemplateStore(templates)), templates);
});

test("tags can be found, removed everywhere and de-duplicated keeping the first", () => {
  assert.equal(hasTag("trig, Full Body, x", "full body"), true);
  assert.equal(hasTag("trig, full body", "body"), false);
  assert.equal(hasTag("", "x"), false);
  assert.equal(removeTag("trig, full body, x, Full Body", "FULL BODY"), "trig, x");
  assert.equal(removeTag("trig, x", "missing"), "trig, x");
  assert.equal(dedupeTags("trig, x, X, y, x"), "trig, x, y");
  assert.equal(dedupeTags(""), "");
});

test("normalizeCaption keeps repeated tags so de-duplication counts as a change", () => {
  assert.equal(normalizeCaption("trig,  x ,X,\n y"), "trig, x, X, y");
  assert.notEqual(normalizeCaption("trig, x, X"), dedupeTags("trig, x, X"));
});
