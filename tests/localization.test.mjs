import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANGUAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "lang/en.json"), "utf8"));

test("the English localization catalog has no duplicate keys", () => {
  const source = fs.readFileSync(path.join(ROOT, "lang/en.json"), "utf8");
  const keys = [...source.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((match) => match[1]);
  const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  assert.deepEqual(duplicates, []);
});

test("localization keys have no scalar namespace collisions", () => {
  const keys = Object.keys(LANGUAGE);
  const keySet = new Set(keys);
  const collisions = [];

  for (const key of keys) {
    const segments = key.split(".");
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join(".");
      if (keySet.has(prefix)) collisions.push(`${prefix} conflicts with ${key}`);
    }
  }

  assert.deepEqual(collisions, []);
});

function filesUnder(directory, extensions) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (extensions.some((extension) => target.endsWith(extension))) files.push(target);
    }
  };
  visit(path.join(ROOT, directory));
  return files;
}

test("every literal localization key used by the system exists", () => {
  const files = [
    ...filesUnder("templates", [".hbs"]),
    ...filesUnder("module", [".mjs"]),
    ...filesUnder("migrations", [".mjs"])
  ];
  const missing = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/["']((?:LYRIAN|TYPES)\.[A-Za-z0-9_.-]+)["']/g)) {
      if (!match[1].endsWith(".") && !(match[1] in LANGUAGE)) {
        missing.push(`${path.relative(ROOT, file)}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("Handlebars templates contain no hard-coded interface prose", () => {
  const offenders = [];
  for (const file of filesUnder("templates", [".hbs"])) {
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(ROOT, file);
    const withoutExpressions = source.replace(/\{\{[\s\S]*?\}\}/g, "");
    for (const match of withoutExpressions.matchAll(/>([^<>]+)</g)) {
      const text = match[1]
        .replace(/&[a-z]+;/gi, "")
        .replace(/\b\d+d\d+\b/gi, "")
        .trim();
      if (/[A-Za-z]/.test(text)) offenders.push(`${relative}: ${text}`);
    }
    for (const match of source.matchAll(/(?:title|aria-label|placeholder)="(?!\{\{)([^"]*[A-Za-z][^"]*)"/g)) {
      offenders.push(`${relative}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("notifications and dialog titles do not use literal English strings", () => {
  const offenders = [];
  const files = [
    ...filesUnder("module", [".mjs"]),
    ...filesUnder("migrations", [".mjs"])
  ];
  const patterns = [
    /ui\.notifications\.(?:warn|info|error)\(\s*(["'`])([^\n]*?)\1/g,
    /window:\s*\{\s*title:\s*(["'`])([^\n]*?)\1/g
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        if (!/^(?:LYRIAN|TYPES)\./.test(match[2])) {
          offenders.push(`${path.relative(ROOT, file)}: ${match[2]}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

/**
 * Keys assembled at runtime escape the literal scan above: nothing reads
 * `LYRIAN.Attack.${attackType}` as a key, so a family that never grew the
 * entry its code asks for stays missing until a GM sees the raw key in a
 * notification. Each family below derives its value set from the module that
 * produces it, so adding a new refusal reason or damage group without its
 * catalog entry fails here rather than in play.
 */
test("every localization key built at runtime resolves to a catalog entry", async () => {
  const { LYRIAN } = await import("../module/config.mjs");
  const { CRAFT_ACTIONS } = await import("../module/rules/crafting-session.mjs");
  const { CUSTOM_OUTPUT_TYPES } = await import("../module/rules/crafting.mjs");

  const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
  const literals = (file, pattern) =>
    [...new Set([...read(file).matchAll(pattern)].map((match) => match[1]).filter(Boolean))];

  const session = "module/rules/crafting-session.mjs";
  const choiceTitles = read("module/rules/proficiencies.mjs")
    .match(/const CHOICE_TITLES = Object\.freeze\(\{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(choiceTitles, "could not locate CHOICE_TITLES to derive its keys");

  const families = {
    // module/rules/damage-types.mjs groups each type, falling back to "other".
    "LYRIAN.DamageGroup.": [
      ...new Set(Object.values(LYRIAN.damageTypes).map((entry) => entry.group)),
      "other"
    ],
    // module/sheets/actor-sheet.mjs and module/documents/actor.mjs.
    "LYRIAN.Craft.Action.": Object.keys(CRAFT_ACTIONS),
    "LYRIAN.Craft.Refused.": literals(session, /\breason:\s*"([a-z]+)"/g),
    "LYRIAN.Craft.ModRefused.": literals(session, /\brefused:\s*"([a-z]+)"/g),
    "LYRIAN.Craft.OutputType.": CUSTOM_OUTPUT_TYPES,
    // module/rules/equipment-import.mjs names the section a drop landed in.
    "LYRIAN.Inventory.Section.": literals(
      "module/rules/equipment-import.mjs", /\btype:\s*"([a-z]+)"/g
    ),
    // module/rules/proficiencies.mjs canonicalises to one of these kinds.
    "LYRIAN.Proficiency.Group.": ["weapons", "armor", "languages"],
    // choiceTitleKey() uses a CHOICE_TITLES key when it knows one, else the kind.
    "LYRIAN.Proficiency.Choice.": [
      ...[...choiceTitles.matchAll(/"([a-z-]+)":/g)].map((match) => match[1]),
      "weapons", "armor", "languages"
    ],
    "LYRIAN.Hybrid.Invalid.": literals(
      "module/rules/hybrid-race.mjs", /\breason:\s*"([a-z]+)"/g
    ),
    // module/integrations/token-action-hud.mjs labels each group by its type.
    "LYRIAN.TAH.ActionType.": literals(
      "module/integrations/token-action-hud.mjs",
      /#(?:itemActions\(\[[^\]]*\]|buildSkillGroup\("[a-z]+"),\s*"([a-z]+)"/g
    )
  };

  const missing = [];
  for (const [prefix, values] of Object.entries(families)) {
    assert.ok(values.length, `${prefix} derived no values to check`);
    for (const value of values) {
      if (!(`${prefix}${value}` in LANGUAGE)) missing.push(`${prefix}${value}`);
    }
  }
  assert.deepEqual(missing, []);

  // A family the table does not know about is unchecked, which is how a key
  // built from a lower-cased value slipped past every other test here. Adding
  // a call site therefore has to declare what that call site can produce.
  const undeclared = [];
  for (const file of [...filesUnder("module", [".mjs"]), ...filesUnder("migrations", [".mjs"])]) {
    for (const match of fs.readFileSync(file, "utf8")
      .matchAll(/`(LYRIAN\.[A-Za-z0-9_.-]*\.)\$\{/g)) {
      if (!(match[1] in families)) undeclared.push(`${path.relative(ROOT, file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(undeclared, []);
});
