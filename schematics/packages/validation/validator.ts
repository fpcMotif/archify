import * as validators from './generated-validators.ts';
import { type SchemaError, type SchemaValidator } from './generated-validators.ts';
import { throwDiagnosticError } from '../diagnostics/diagnostics.ts';

const validatorsByType: Readonly<Record<string, SchemaValidator | undefined>> = validators;

// "/nodes/3/label" reads much better as "/nodes/3 (id: "router") /label" for the
// LLM fixing the JSON; resolve the nearest enclosing element's id or label.
function annotatedPath(instancePath: string, data: unknown): { path: string; identity: string | null } {
  if (!instancePath) return { path: '/', identity: null };
  let node = data;
  let hint = null;
  for (const seg of instancePath.split('/').slice(1)) {
    if (node == null || typeof node !== 'object') break;
    node = Reflect.get(node, /^\d+$/.test(seg) ? Number(seg) : seg);
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const tag = Reflect.get(node, 'id') ?? Reflect.get(node, 'label');
      if (tag != null) hint = String(tag);
    }
  }
  return { path: instancePath, identity: hint };
}

function annotatePath(instancePath: string, data: unknown): string {
  const annotated = annotatedPath(instancePath, data);
  return annotated.identity != null
    ? `${annotated.path} (id/label: ${JSON.stringify(annotated.identity)})`
    : annotated.path;
}

function formatErrors(errors: readonly SchemaError[], data: unknown): string {
  return errors.map((e) => {
    const where = annotatePath(e.instancePath, data);
    const detail = e.params && Object.keys(e.params).length
      ? ' ' + JSON.stringify(e.params)
      : '';
    return `  ${where} ${e.message}${detail}`;
  }).join('\n');
}

export function validateSchema(diagramType: string, data: unknown): void {
  const validate = validatorsByType[diagramType];
  if (!validate) {
    throw new Error(`validateSchema: unknown diagram type "${diagramType}"`);
  }
  if (!validate(data)) {
    const errors = validate.errors ?? [];
    const diagnostics = errors.map((error) => {
      const annotated = annotatedPath(error.instancePath, data);
      const subject = {
        diagramType,
        path: annotated.path,
        ...(annotated.identity != null ? { identity: String(annotated.identity) } : {}),
      };
      const evidence = {
        keyword: error.keyword,
        expected: error.schema,
        ...error.params,
      };
      const fixesByKeyword: Record<string, string[] | undefined> = {
        additionalProperties: [`remove unsupported property ${JSON.stringify(error.params?.additionalProperty)}`],
        required: [`add required property ${JSON.stringify(error.params?.missingProperty)}`],
        type: [`use ${JSON.stringify(error.params?.type)} at ${annotated.path}`],
        enum: [`choose one of the allowed values`],
        pattern: [`match the required pattern ${JSON.stringify(error.params?.pattern)}`],
        minimum: [`use a value ${error.params?.comparison || '>='} ${error.params?.limit}`],
        maximum: [`use a value ${error.params?.comparison || '<='} ${error.params?.limit}`],
        minItems: [`provide at least ${error.params?.limit} item(s)`],
        maxItems: [`provide at most ${error.params?.limit} item(s)`],
        minLength: [`provide at least ${error.params?.limit} character(s)`],
        maxLength: [`provide at most ${error.params?.limit} character(s)`],
      };
      const supportedFixes = fixesByKeyword[error.keyword] || [];
      return {
        code: `schema/${error.keyword}`,
        severity: 'error',
        message: `${annotatePath(error.instancePath, data)} ${error.message}`,
        subject,
        evidence,
        supportedFixes,
      };
    });
    throwDiagnosticError(
      `${diagramType} schema validation failed:\n${formatErrors(errors, data)}`,
      diagnostics,
    );
  }
}
