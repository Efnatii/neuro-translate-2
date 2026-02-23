/**
 * Lightweight JSON schema validator for tool arguments.
 * Supports subset used by tool manifest: type/required/enum/additionalProperties/items/min/max.
 */
(function initJsonSchemaValidator(global) {
  const NT = global.NT || (global.NT = {});

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  class JsonSchemaValidator {
    validate(schema, value) {
      const errors = [];
      this._validateNode(schema || {}, value, '$', errors);
      return {
        ok: errors.length === 0,
        errors
      };
    }

    _pushError(errors, path, code, message) {
      errors.push({ path, code, message });
    }

    _validateNode(schema, value, path, errors) {
      const node = isObject(schema) ? schema : {};
      if (Array.isArray(node.enum)) {
        const allowed = node.enum;
        const found = allowed.some((item) => this._deepEqual(item, value));
        if (!found) {
          this._pushError(errors, path, 'ENUM_MISMATCH', `Expected one of enum values`);
          return;
        }
      }

      if (node.type) {
        const typeOk = this._checkType(node.type, value);
        if (!typeOk) {
          this._pushError(errors, path, 'TYPE_MISMATCH', `Expected type ${String(node.type)}`);
          return;
        }
      }

      if (typeof value === 'string') {
        if (Number.isFinite(Number(node.minLength)) && value.length < Number(node.minLength)) {
          this._pushError(errors, path, 'MIN_LENGTH', `String is shorter than minLength`);
        }
        if (Number.isFinite(Number(node.maxLength)) && value.length > Number(node.maxLength)) {
          this._pushError(errors, path, 'MAX_LENGTH', `String exceeds maxLength`);
        }
        if (typeof node.pattern === 'string' && node.pattern) {
          try {
            const pattern = new RegExp(node.pattern);
            if (!pattern.test(value)) {
              this._pushError(errors, path, 'PATTERN_MISMATCH', 'String does not match pattern');
            }
          } catch (_) {
            // ignore invalid patterns
          }
        }
      }

      if (typeof value === 'number') {
        if (Number.isFinite(Number(node.minimum)) && value < Number(node.minimum)) {
          this._pushError(errors, path, 'MINIMUM', 'Number is below minimum');
        }
        if (Number.isFinite(Number(node.maximum)) && value > Number(node.maximum)) {
          this._pushError(errors, path, 'MAXIMUM', 'Number exceeds maximum');
        }
      }

      if (Array.isArray(value)) {
        if (Number.isFinite(Number(node.minItems)) && value.length < Number(node.minItems)) {
          this._pushError(errors, path, 'MIN_ITEMS', 'Array has too few items');
        }
        if (Number.isFinite(Number(node.maxItems)) && value.length > Number(node.maxItems)) {
          this._pushError(errors, path, 'MAX_ITEMS', 'Array has too many items');
        }
        const itemSchema = node.items;
        if (itemSchema && typeof itemSchema === 'object') {
          for (let i = 0; i < value.length; i += 1) {
            this._validateNode(itemSchema, value[i], `${path}[${i}]`, errors);
          }
        }
      }

      if (isObject(value)) {
        const props = isObject(node.properties) ? node.properties : {};
        const required = Array.isArray(node.required) ? node.required : [];
        required.forEach((key) => {
          if (!Object.prototype.hasOwnProperty.call(value, key)) {
            this._pushError(errors, `${path}.${key}`, 'REQUIRED', `Missing required property: ${key}`);
          }
        });

        Object.keys(value).forEach((key) => {
          const childPath = `${path}.${key}`;
          if (Object.prototype.hasOwnProperty.call(props, key)) {
            this._validateNode(props[key], value[key], childPath, errors);
            return;
          }
          if (node.additionalProperties === false) {
            this._pushError(errors, childPath, 'ADDITIONAL_PROPERTY', `Unexpected property: ${key}`);
            return;
          }
          if (isObject(node.additionalProperties)) {
            this._validateNode(node.additionalProperties, value[key], childPath, errors);
          }
        });
      }
    }

    _checkType(type, value) {
      const expected = String(type);
      if (expected === 'array') {
        return Array.isArray(value);
      }
      if (expected === 'object') {
        return isObject(value);
      }
      if (expected === 'string') {
        return typeof value === 'string';
      }
      if (expected === 'boolean') {
        return typeof value === 'boolean';
      }
      if (expected === 'integer') {
        return Number.isInteger(value);
      }
      if (expected === 'number') {
        return typeof value === 'number' && Number.isFinite(value);
      }
      if (expected === 'null') {
        return value === null;
      }
      return true;
    }

    _deepEqual(a, b) {
      if (a === b) {
        return true;
      }
      if (typeof a !== typeof b) {
        return false;
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
          return false;
        }
        for (let i = 0; i < a.length; i += 1) {
          if (!this._deepEqual(a[i], b[i])) {
            return false;
          }
        }
        return true;
      }
      if (isObject(a) && isObject(b)) {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) {
          return false;
        }
        for (let i = 0; i < keysA.length; i += 1) {
          const key = keysA[i];
          if (!Object.prototype.hasOwnProperty.call(b, key) || !this._deepEqual(a[key], b[key])) {
            return false;
          }
        }
        return true;
      }
      return false;
    }
  }

  NT.JsonSchemaValidator = JsonSchemaValidator;
})(globalThis);
