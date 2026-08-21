export class JsoncParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  parse() {
    this.skipIgnored();
    const value = this.parseValue();
    this.skipIgnored();
    if (this.index !== this.source.length) {
      throw new Error("OpenCode config contains unexpected content.");
    }
    return value;
  }

  skipIgnored() {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index])) {
        this.index += 1;
        continue;
      }

      if (this.source.startsWith("//", this.index)) {
        const newline = this.source.indexOf("\n", this.index + 2);
        this.index = newline === -1 ? this.source.length : newline + 1;
        continue;
      }

      if (this.source.startsWith("/*", this.index)) {
        const end = this.source.indexOf("*/", this.index + 2);
        if (end === -1) throw new Error("OpenCode config contains an unterminated comment.");
        this.index = end + 2;
        continue;
      }

      break;
    }
  }

  parseValue() {
    this.skipIgnored();
    const start = this.index;
    const character = this.source[this.index];

    if (character === "{") return this.parseObject(start);
    if (character === "[") return this.parseArray(start);
    if (character === '"') return this.parseString(start);

    const match = this.source.slice(this.index).match(/^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new Error(`OpenCode config contains an invalid value at ${start}.`);

    this.index += match[0].length;
    return {
      type: match[0] === "null" ? "null" : typeof JSON.parse(match[0]),
      start,
      end: this.index,
      value: JSON.parse(match[0]),
    };
  }

  parseString(start) {
    this.index += 1;
    let escaped = false;

    while (this.index < this.source.length) {
      const character = this.source[this.index];
      this.index += 1;

      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        return {
          type: "string",
          start,
          end: this.index,
          value: JSON.parse(this.source.slice(start, this.index)),
        };
      }
    }

    throw new Error("OpenCode config contains an unterminated string.");
  }

  parseObject(start) {
    this.index += 1;
    const properties = [];
    this.skipIgnored();

    while (this.index < this.source.length && this.source[this.index] !== "}") {
      const key = this.parseString(this.index);
      this.skipIgnored();
      if (this.source[this.index] !== ":") {
        throw new Error("OpenCode config object is missing a colon.");
      }
      this.index += 1;
      const value = this.parseValue();
      this.skipIgnored();

      let commaEnd;
      if (this.source[this.index] === ",") {
        this.index += 1;
        commaEnd = this.index;
        this.skipIgnored();
      } else if (this.source[this.index] !== "}") {
        throw new Error("OpenCode config object is missing a comma.");
      }

      properties.push({ key: key.value, keyNode: key, value, commaEnd });
    }

    if (this.source[this.index] !== "}") {
      throw new Error("OpenCode config object is not closed.");
    }
    this.index += 1;

    return { type: "object", start, end: this.index, properties };
  }

  parseArray(start) {
    this.index += 1;
    const items = [];
    this.skipIgnored();

    while (this.index < this.source.length && this.source[this.index] !== "]") {
      const value = this.parseValue();
      this.skipIgnored();

      let commaEnd;
      if (this.source[this.index] === ",") {
        this.index += 1;
        commaEnd = this.index;
        this.skipIgnored();
      } else if (this.source[this.index] !== "]") {
        throw new Error("OpenCode config array is missing a comma.");
      }

      items.push({ ...value, commaEnd });
    }

    if (this.source[this.index] !== "]") {
      throw new Error("OpenCode config array is not closed.");
    }
    this.index += 1;

    return { type: "array", start, end: this.index, items };
  }
}

export function parseJsonc(source) {
  return new JsoncParser(source).parse();
}

export function findProperty(object, key) {
  return object?.properties?.find((property) => property.key === key);
}

function lineIndent(source, position) {
  const lineStart = source.lastIndexOf("\n", position - 1) + 1;
  return source.slice(lineStart, position).match(/^\s*/)?.[0] ?? "";
}

function isMultiline(source, start, end) {
  return source.slice(start, end).includes("\n");
}

export function insertObjectProperty(source, object, key, value) {
  return insertObjectProperties(source, object, [{ key, value }]);
}

export function insertArrayItem(source, array, value) {
  const itemText = JSON.stringify(value);
  if (array.items.length === 0) {
    const closeLineStart = source.lastIndexOf("\n", array.end - 2) + 1;
    if (isMultiline(source, array.start, array.end)) {
      const indent = lineIndent(source, array.end - 1);
      return { position: closeLineStart, text: `${indent}  ${itemText}\n` };
    }
    return { position: array.end - 1, text: itemText };
  }

  const last = array.items[array.items.length - 1];
  if (isMultiline(source, array.start, array.end)) {
    const indent = lineIndent(source, last.start);
    if (last.commaEnd) {
      const closeLineStart = source.lastIndexOf("\n", array.end - 2) + 1;
      return { position: closeLineStart, text: `${indent}${itemText}\n` };
    }
    return { position: last.end, text: `,\n${indent}${itemText}` };
  }

  const position = last.commaEnd ?? last.end;
  return { position, text: `${last.commaEnd ? "" : ", "}${itemText}` };
}

export function applyEdits(source, edits) {
  return [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) => `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`,
      source,
    );
}

export function insertObjectProperties(source, object, properties) {
  const propertyText = formatObjectProperties(properties, ", ");
  if (object.properties.length === 0) {
    const closeLineStart = source.lastIndexOf("\n", object.end - 2) + 1;
    if (isMultiline(source, object.start, object.end)) {
      const indent = lineIndent(source, object.end - 1);
      return {
        position: closeLineStart,
        text: `${indent}  ${formatObjectProperties(properties, `,\n${indent}  `)}\n`,
      };
    }
    return { position: object.end - 1, text: ` ${propertyText} ` };
  }

  const last = object.properties[object.properties.length - 1];
  if (isMultiline(source, object.start, object.end)) {
    const indent = lineIndent(source, last.keyNode.start);
    const lines = formatObjectProperties(properties, ",\n", indent);
    if (last.commaEnd) {
      const closeLineStart = source.lastIndexOf("\n", object.end - 2) + 1;
      return { position: closeLineStart, text: `${lines},\n` };
    }
    return { position: last.value.end, text: `,\n${lines}` };
  }

  const position = last.commaEnd ?? last.value.end;
  return { position, text: `${last.commaEnd ? "" : ", "}${propertyText}` };
}

function formatObjectProperties(properties, separator, prefix = "") {
  return properties
    .map(({ key, value }) => `${prefix}${JSON.stringify(key)}: ${value}`)
    .join(separator);
}
