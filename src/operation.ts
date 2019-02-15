import {
  GraphQLSchema,
  GraphQLObjectType,
  isObjectType,
  getNamedType,
  isUnionType,
  DocumentNode,
  OperationDefinitionNode,
  VariableDefinitionNode,
  isNonNullType,
  SelectionNode,
  InlineFragmentNode,
  GraphQLNamedType,
  SelectionSetNode,
  isScalarType,
  TypeNode,
  isListType,
  ArgumentNode,
  GraphQLField,
  GraphQLArgument,
  GraphQLInputType,
  GraphQLList,
  ListTypeNode,
  GraphQLNonNull,
  NonNullTypeNode,
  OperationTypeNode,
} from 'graphql';
import * as changeCase from 'change-case';

import { Ignore } from './types';

let operationVariables: VariableDefinitionNode[] = [];

function addOperationVariable(variable: VariableDefinitionNode) {
  operationVariables.push(variable);
}

function resetOperationVariables() {
  operationVariables = [];
}

function buildOperationName(name: string) {
  return changeCase.camel(name);
}

export type Skip = string[];
export type Force = string[];

export function buildOperation({
  schema,
  kind,
  field,
  models,
  ignore,
}: {
  schema: GraphQLSchema;
  kind: OperationTypeNode;
  field: string;
  models: string[];
  ignore: Ignore;
}) {
  resetOperationVariables();

  const document = buildDocumentNode({
    schema,
    fieldName: field,
    kind,
    models,
    ignore,
  });

  // attach variables
  (document.definitions[0] as any).variableDefinitions = [
    ...operationVariables,
  ];

  resetOperationVariables();

  return document;
}

function buildDocumentNode({
  schema,
  fieldName,
  kind,
  models,
  ignore,
}: {
  schema: GraphQLSchema;
  fieldName: string;
  kind: OperationTypeNode;
  models: string[];
  ignore: Ignore;
}) {
  const typeMap: Record<OperationTypeNode, GraphQLObjectType> = {
    query: schema.getQueryType()!,
    mutation: schema.getMutationType()!,
    subscription: schema.getSubscriptionType()!,
  };
  const type = typeMap[kind];
  const field = type.getFields()[fieldName];
  const operationName = buildOperationName(`${fieldName}_${kind}`);

  if (field.args) {
    field.args.forEach(arg => {
      addOperationVariable(resolveVariable(arg));
    });
  }

  const operationNode: OperationDefinitionNode = {
    kind: 'OperationDefinition',
    operation: kind,
    name: {
      kind: 'Name',
      value: operationName,
    },
    variableDefinitions: [],
    selectionSet: {
      kind: 'SelectionSet',
      selections: [
        resolveField({
          type,
          field,
          models,
          firstCall: true,
          path: [],
          ignore,
        }),
      ],
    },
  };
  const document: DocumentNode = {
    kind: 'Document',
    definitions: [operationNode],
  };

  return document;
}

const visitedTypes: Record<string, boolean> = {};

function resolveSelectionSet({
  parent,
  type,
  models,
  firstCall,
  path,
  ignore,
}: {
  parent: GraphQLNamedType;
  type: GraphQLNamedType;
  models: string[];
  path: string[];
  firstCall?: boolean;
  ignore: Ignore;
}): SelectionSetNode | undefined {
  if (isUnionType(type)) {
    const types = type.getTypes();

    return {
      kind: 'SelectionSet',
      selections: types.map<InlineFragmentNode>(t => {
        const fields = t.getFields();

        return {
          kind: 'InlineFragment',
          typeCondition: {
            kind: 'NamedType',
            name: {
              kind: 'Name',
              value: t.name,
            },
          },
          selectionSet: {
            kind: 'SelectionSet',
            selections: Object.keys(fields).map(fieldName => {
              return resolveField({
                type: t,
                field: fields[fieldName],
                models,
                path: [...path, fieldName],
                ignore,
              });
            }),
          },
        };
      }),
    };
  }

  if (isObjectType(type)) {
    const isIgnored =
      ignore.includes(type.name) ||
      ignore.includes(`${parent.name}.${path[path.length - 1]}`);
    const isModel = models.includes(type.name);

    if (!firstCall && isModel && !isIgnored) {
      return {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: {
              kind: 'Name',
              value: 'id',
            },
          },
        ],
      };
    }

    const fields = type.getFields();
    let filtered: Record<string, any> = {};

    // We need to filter the fields for types we've seen
    // otherwise the field name shows up without the deeper selection of it's subfields
    Object.values(fields).map(field => {
      let found = visitedTypes[String(field.type)];
      // If we have seen this type, then don't recurse again by filtering it
      if (found) {
        return;
      }
      // Otherwise we should figure out the sub-selection for this field
      filtered[field.name] = field;
    });

    // Mark the type as visited before we recurse
    visitedTypes[type.name] = true;

    // Create the selection sets across the filtered fields
    const ret: SelectionSetNode = {
      kind: 'SelectionSet',
      selections: Object.keys(filtered).map(fieldName => {
        return resolveField({
          type: type,
          field: fields[fieldName],
          models,
          path: [...path, fieldName],
          ignore,
        });
      }),
    };

    // make the type as un-visited as we unwind recursion
    visitedTypes[type.name] = false;
    return ret;
  }
}

function resolveVariable(
  arg: GraphQLArgument,
  name?: string
): VariableDefinitionNode {
  function resolveVariableType(type: GraphQLList<any>): ListTypeNode;
  function resolveVariableType(type: GraphQLNonNull<any>): NonNullTypeNode;
  function resolveVariableType(type: GraphQLInputType): TypeNode;
  function resolveVariableType(type: GraphQLInputType): TypeNode {
    if (isListType(type)) {
      return {
        kind: 'ListType',
        type: resolveVariableType(type.ofType),
      };
    }

    if (isNonNullType(type)) {
      return {
        kind: 'NonNullType',
        type: resolveVariableType(type.ofType),
      };
    }

    return {
      kind: 'NamedType',
      name: {
        kind: 'Name',
        value: type.name,
      },
    };
  }

  return {
    kind: 'VariableDefinition',
    variable: {
      kind: 'Variable',
      name: {
        kind: 'Name',
        value: name || arg.name,
      },
    },
    type: resolveVariableType(arg.type),
  };
}

function getArgumentName(name: string, path: string[]): string {
  return changeCase.camel([...path, name].join('_'));
}

function resolveField({
  type,
  field,
  models,
  firstCall,
  path,
  ignore,
}: {
  type: GraphQLObjectType;
  field: GraphQLField<any, any>;
  models: string[];
  path: string[];
  firstCall?: boolean;
  ignore: Ignore;
}): SelectionNode {
  const namedType = getNamedType(field.type);
  let args: ArgumentNode[] = [];

  if (field.args && field.args.length) {
    args = field.args.map<ArgumentNode>(arg => {
      if (!firstCall) {
        addOperationVariable(
          resolveVariable(arg, getArgumentName(arg.name, path))
        );
      }

      return {
        kind: 'Argument',
        name: {
          kind: 'Name',
          value: arg.name,
        },
        value: {
          kind: 'Variable',
          name: {
            kind: 'Name',
            value: getArgumentName(arg.name, path),
          },
        },
      };
    });
  }

  if (!isScalarType(namedType)) {
    return {
      kind: 'Field',
      name: {
        kind: 'Name',
        value: field.name,
      },
      selectionSet: resolveSelectionSet({
        parent: type,
        type: namedType,
        models,
        firstCall,
        path: [...path, field.name],
        ignore,
      }),
      arguments: args,
    };
  }

  return {
    kind: 'Field',
    name: {
      kind: 'Name',
      value: field.name,
    },
    arguments: args,
  };
}
