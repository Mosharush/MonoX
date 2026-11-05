const annotations = new Set([
  '$anchor',
  '$comment',
  '$defs',
  '$id',
  '$schema',
  '$vocabulary',
  'default',
  'deprecated',
  'description',
  'examples',
  'title',
]);

const supportedKeywords = new Set([
  ...annotations,
  '$ref',
  'additionalProperties',
  'const',
  'enum',
  'items',
  'maximum',
  'maxLength',
  'minimum',
  'minItems',
  'minLength',
  'minProperties',
  'oneOf',
  'pattern',
  'properties',
  'propertyNames',
  'required',
  'type',
  'uniqueItems',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function joinPath(parent, key) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function issue(pathName, message, keyword) {
  return { path: pathName, message, keyword };
}

function decodePointer(part) {
  return decodeURIComponent(part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function resolvePointer(root, ref) {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    const key = decodePointer(part);
    if (!isObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function matchesType(instance, type) {
  switch (type) {
    case 'array':
      return Array.isArray(instance);
    case 'boolean':
      return typeof instance === 'boolean';
    case 'integer':
      return typeof instance === 'number' && Number.isInteger(instance);
    case 'null':
      return instance === null;
    case 'number':
      return typeof instance === 'number' && Number.isFinite(instance);
    case 'object':
      return isObject(instance);
    case 'string':
      return typeof instance === 'string';
    default:
      return undefined;
  }
}

function validateNode(instance, schema, pathName, root, depth) {
  if (schema === true) return [];
  if (schema === false) return [issue(pathName, 'is not allowed by the schema', 'schema')];
  if (!isObject(schema)) return [issue(pathName, 'schema must be an object or boolean', 'schema')];
  if (depth > 32) return [issue(pathName, 'schema reference exceeded the maximum depth', '$ref')];

  const errors = [];
  for (const key of Object.keys(schema)) {
    if (!supportedKeywords.has(key))
      errors.push(issue(pathName, `unsupported schema keyword ${key}`, 'schema'));
  }

  if (typeof schema.$ref === 'string') {
    const resolved = resolvePointer(root, schema.$ref);
    if (resolved === undefined) {
      errors.push(issue(pathName, `unresolvable schema reference ${schema.$ref}`, '$ref'));
    } else {
      errors.push(...validateNode(instance, resolved, pathName, root, depth + 1));
    }
  } else if (schema.$ref !== undefined) {
    errors.push(issue(pathName, 'schema reference must be a string', '$ref'));
  }

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter(
      (option) => validateNode(instance, option, pathName, root, depth + 1).length === 0
    ).length;
    if (matched !== 1) {
      errors.push(issue(pathName, `must match exactly one subschema (matched ${matched})`, 'oneOf'));
    }
  }

  if (Object.hasOwn(schema, 'const') && canonical(instance) !== canonical(schema.const)) {
    errors.push(issue(pathName, `must be ${JSON.stringify(schema.const)}`, 'const'));
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((value) => canonical(value) === canonical(instance))) {
    errors.push(
      issue(
        pathName,
        `must be one of: ${schema.enum.map((value) => JSON.stringify(value)).join(', ')}`,
        'enum'
      )
    );
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.map((type) => matchesType(instance, type));
    if (matches.some((match) => match === undefined)) {
      errors.push(issue(pathName, 'schema type is unsupported', 'type'));
      return errors;
    }
    if (!matches.some(Boolean)) {
      errors.push(issue(pathName, `must be ${types.join(' or ')}`, 'type'));
      return errors;
    }
  }

  if (typeof schema.pattern === 'string' && typeof instance === 'string') {
    let expression;
    try {
      expression = new RegExp(schema.pattern, 'u');
    } catch {
      errors.push(issue(pathName, 'schema pattern is invalid', 'pattern'));
      expression = undefined;
    }
    if (expression && !expression.test(instance))
      errors.push(issue(pathName, `must match ${schema.pattern}`, 'pattern'));
  }
  if (
    typeof schema.minLength === 'number' &&
    typeof instance === 'string' &&
    instance.length < schema.minLength
  ) {
    errors.push(issue(pathName, `must contain at least ${schema.minLength} character(s)`, 'minLength'));
  }
  if (
    typeof schema.maxLength === 'number' &&
    typeof instance === 'string' &&
    instance.length > schema.maxLength
  ) {
    errors.push(issue(pathName, `must contain at most ${schema.maxLength} character(s)`, 'maxLength'));
  }
  if (typeof schema.minimum === 'number' && typeof instance === 'number' && instance < schema.minimum) {
    errors.push(issue(pathName, `must be greater than or equal to ${schema.minimum}`, 'minimum'));
  }
  if (typeof schema.maximum === 'number' && typeof instance === 'number' && instance > schema.maximum) {
    errors.push(issue(pathName, `must be less than or equal to ${schema.maximum}`, 'maximum'));
  }

  if (Array.isArray(instance)) {
    if (schema.items === false) {
      instance.forEach((_, index) =>
        errors.push(issue(`${pathName}[${index}]`, 'is not allowed by the schema', 'items'))
      );
    } else if (isObject(schema.items)) {
      instance.forEach((item, index) =>
        errors.push(...validateNode(item, schema.items, `${pathName}[${index}]`, root, depth + 1))
      );
    } else if (schema.items !== undefined && schema.items !== true) {
      errors.push(issue(pathName, 'schema items must be a schema', 'items'));
    }
    if (typeof schema.minItems === 'number' && instance.length < schema.minItems) {
      errors.push(issue(pathName, `must contain at least ${schema.minItems} item(s)`, 'minItems'));
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      instance.forEach((item, index) => {
        const key = canonical(item);
        if (seen.has(key)) errors.push(issue(`${pathName}[${index}]`, 'must be unique', 'uniqueItems'));
        seen.add(key);
      });
    }
  }

  if (isObject(instance)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(instance, key))
          errors.push(issue(joinPath(pathName, key), 'is required', 'required'));
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const key of Object.keys(instance))
        errors.push(...validateNode(key, schema.propertyNames, joinPath(pathName, key), root, depth + 1));
    }
    if (typeof schema.minProperties === 'number' && Object.keys(instance).length < schema.minProperties) {
      errors.push(issue(pathName, `must contain at least ${schema.minProperties} property`, 'minProperties'));
    }
    for (const [key, value] of Object.entries(instance)) {
      if (Object.hasOwn(properties, key)) {
        errors.push(...validateNode(value, properties[key], joinPath(pathName, key), root, depth + 1));
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(issue(joinPath(pathName, key), 'is not allowed', 'additionalProperties'));
      } else if (isObject(schema.additionalProperties)) {
        errors.push(
          ...validateNode(value, schema.additionalProperties, joinPath(pathName, key), root, depth + 1)
        );
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        errors.push(issue(pathName, 'schema additionalProperties must be a schema or boolean', 'schema'));
      }
    }
  }

  return errors;
}

export function validateJsonSchema(instance, schema) {
  const root = schema === true || schema === false || !isObject(schema) ? {} : schema;
  const errors = validateNode(instance, schema, '$', root, 0);
  return { valid: errors.length === 0, errors };
}
