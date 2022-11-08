import { memoize1 } from '@graphql-tools/utils';
import { OperationDefinitionNode } from 'graphql';

export function isPromiseLike(obj: any): obj is PromiseLike<any> {
  return typeof obj.then === 'function';
}

export const isLiveQueryOperationDefinitionNode = memoize1(function isLiveQueryOperationDefinitionNode(
  node: OperationDefinitionNode
) {
  return node.directives?.some(directive => directive.name.value === 'live');
});
