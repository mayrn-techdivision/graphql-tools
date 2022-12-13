import { createDefaultExecutor, SubschemaConfig } from '@graphql-tools/delegate';
import { ExecutionResult, Executor } from '@graphql-tools/utils';
import {
  ASTVisitFn,
  buildASTSchema,
  concatAST,
  FieldDefinitionNode,
  GraphQLSchema,
  Kind,
  ObjectTypeDefinitionNode,
  ObjectTypeExtensionNode,
  parse,
  print,
  visit,
} from 'graphql';

export const baseSDL = /* GraphQL */ `
  scalar _Any
  scalar FieldSet
  scalar link__Import

  enum link__Purpose {
    SECURITY
    EXECUTION
  }

  type _Service {
    sdl: String!
  }

  type Query {
    _entities(representations: [_Any!]!): [_Entity]!
    _service: _Service!
  }

  directive @external on FIELD_DEFINITION | OBJECT
  directive @requires(fields: FieldSet!) on FIELD_DEFINITION
  directive @provides(fields: FieldSet!) on FIELD_DEFINITION
  directive @key(fields: FieldSet!, resolvable: Boolean = true) repeatable on OBJECT | INTERFACE
  directive @link(url: String!, as: String, for: link__Purpose, import: [link__Import]) repeatable on SCHEMA
  directive @shareable repeatable on OBJECT | FIELD_DEFINITION
  directive @inaccessible on FIELD_DEFINITION | OBJECT | INTERFACE | UNION | ARGUMENT_DEFINITION | SCALAR | ENUM | ENUM_VALUE | INPUT_OBJECT | INPUT_FIELD_DEFINITION
  directive @tag(
    name: String!
  ) repeatable on FIELD_DEFINITION | INTERFACE | OBJECT | UNION | ARGUMENT_DEFINITION | SCALAR | ENUM | ENUM_VALUE | INPUT_OBJECT | INPUT_FIELD_DEFINITION
  directive @override(from: String!) on FIELD_DEFINITION
  directive @composeDirective(name: String!) repeatable on SCHEMA

  directive @extends on OBJECT | INTERFACE
`;

export type FederationConfig =
  | FederationConfigWithExecutor
  | FederationConfigWithSchema
  | FederationConfigWithSDLAndExecutor;

export type FederationConfigWithSDLAndExecutor = {
  sdl: string;
  executor: Executor;
};
export type FederationConfigWithExecutor = {
  executor: Executor;
};
export type FederationConfigWithSchema = {
  schema: GraphQLSchema;
};

const SDLQuery = /* GraphQL */ `
  query SDLQuery {
    _service {
      sdl
    }
  }
`;

const FederationArgsFromKeys = (representations: readonly any[]) => ({ representations });
const FederationKeyFactory = (root: any) =>
  Object.fromEntries(Object.entries(root).filter(([_, value]) => value != null));

export async function useFederation(config: FederationConfig): Promise<SubschemaConfig> {
  let sdl: string;
  let executor: Executor;
  if ('sdl' in config) {
    sdl = config.sdl;
    executor = config.executor;
  } else if ('schema' in config) {
    executor = createDefaultExecutor(config.schema);
    const sdlQueryResult = (await executor({
      document: parse(SDLQuery),
    })) as ExecutionResult<any>;
    sdl = sdlQueryResult.data._service.sdl;
  } else {
    executor = config.executor;
    const sdlQueryResult = (await executor({
      document: parse(SDLQuery),
    })) as ExecutionResult<any>;
    sdl = sdlQueryResult.data._service.sdl;
  }
  const subschemaConfig = {} as SubschemaConfig;
  const typeMergingConfig = (subschemaConfig.merge = subschemaConfig.merge || {});
  const entityTypes: string[] = [];
  const visitor: ASTVisitFn<ObjectTypeDefinitionNode | ObjectTypeExtensionNode> = node => {
    if (node.directives) {
      const typeName = node.name.value;
      const selections: string[] = [];
      for (const directive of node.directives) {
        const directiveArgs = directive.arguments || [];
        switch (directive.name.value) {
          case 'key': {
            if (
              directiveArgs.some(
                arg => arg.name.value === 'resolvable' && arg.value.kind === Kind.BOOLEAN && arg.value.value === false
              )
            ) {
              continue;
            }
            const selectionValueNode = directiveArgs.find(arg => arg.name.value === 'fields')?.value;
            if (selectionValueNode?.kind === Kind.STRING) {
              selections.push(selectionValueNode.value);
            }
            break;
          }
          case 'inaccessible':
            return null;
        }
      }
      const typeMergingTypeConfig = (typeMergingConfig[typeName] = typeMergingConfig[typeName] || {});
      if (node.kind === Kind.OBJECT_TYPE_DEFINITION) {
        typeMergingTypeConfig.canonical = true;
      }
      if (selections.length > 0) {
        entityTypes.push(typeName);
        typeMergingTypeConfig.selectionSet = `{ ${selections.join(' ')} }`;
        typeMergingTypeConfig.key = FederationKeyFactory;
        typeMergingTypeConfig.argsFromKeys = FederationArgsFromKeys;
        typeMergingTypeConfig.fieldName = `_entities`;
      }
      const fields = [];
      if (node.fields) {
        for (const fieldNode of node.fields) {
          let removed = false;
          if (fieldNode.directives) {
            const fieldName = fieldNode.name.value;
            for (const directive of fieldNode.directives) {
              const directiveArgs = directive.arguments || [];
              switch (directive.name.value) {
                case 'requires': {
                  const typeMergingFieldsConfig = (typeMergingTypeConfig.fields = typeMergingTypeConfig.fields || {});
                  typeMergingFieldsConfig[fieldName] = typeMergingFieldsConfig[fieldName] || {};
                  if (
                    directiveArgs.some(
                      arg =>
                        arg.name.value === 'resolvable' && arg.value.kind === Kind.BOOLEAN && arg.value.value === false
                    )
                  ) {
                    continue;
                  }
                  const selectionValueNode = directiveArgs.find(arg => arg.name.value === 'fields')?.value;
                  if (selectionValueNode?.kind === Kind.STRING) {
                    typeMergingFieldsConfig[fieldName].selectionSet = `{ ${selectionValueNode.value} }`;
                    typeMergingFieldsConfig[fieldName].computed = true;
                  }
                  break;
                }
                case 'external':
                case 'inaccessible': {
                  removed = !typeMergingTypeConfig.selectionSet?.includes(` ${fieldName} `);
                  break;
                }
                case 'override': {
                  const typeMergingFieldsConfig = (typeMergingTypeConfig.fields = typeMergingTypeConfig.fields || {});
                  typeMergingFieldsConfig[fieldName] = typeMergingFieldsConfig[fieldName] || {};
                  typeMergingFieldsConfig[fieldName].canonical = true;
                  break;
                }
              }
            }
          }
          if (!removed) {
            fields.push(fieldNode);
          }
        }
        (node.fields as FieldDefinitionNode[]) = fields;
      }
    }
    return {
      ...node,
      kind: Kind.OBJECT_TYPE_DEFINITION,
    };
  };
  const parsedSDL = visit(parse(sdl), {
    ObjectTypeExtension: visitor,
    ObjectTypeDefinition: visitor,
  });
  subschemaConfig.schema = buildASTSchema(
    concatAST([parse(`union _Entity = ${entityTypes.join(' | ')}` + baseSDL), parsedSDL]),
    {
      assumeValidSDL: true,
      assumeValid: true,
    }
  );
  subschemaConfig.executor = executor;
  subschemaConfig.batch = true;
  return subschemaConfig;
}
