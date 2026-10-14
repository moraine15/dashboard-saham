"use strict";

// Pull top-level functions out of a static/*.js file that cannot load in Node
// as a whole (app.js needs the browser), so pure helpers can still be tested.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function functionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name} is not closed`);
}

// Returns the named functions, evaluated together with the given globals.
function extract(file, names, globals = {}) {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "static", file), "utf8");
  const context = { Number, Math, isNaN, parseFloat, String, ...globals };
  vm.runInNewContext(names.map((name) => functionSource(src, name)).join("\n"), context);
  return context;
}

module.exports = { extract };
