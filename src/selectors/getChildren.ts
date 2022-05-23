import _ from 'lodash'
import { getSortPreference, hasChild, thoughtToPath } from '../selectors'
import {
  compareByRank,
  compareThought,
  compareThoughtDescending,
  contextToThoughtId,
  isAbsolute,
  isFunction,
  sort,
  unroot,
  isDescendantPath,
  splice,
  head,
} from '../util'
import { ThoughtId, ComparatorFunction, Context, ThoughtContext, Thought, Path, State, SimplePath } from '../@types'
import childIdsToThoughts from './childIdsToThoughts'
import getThoughtById from './getThoughtById'

// use global instance of empty array so object reference doesn't change
const noChildren: Thought[] = []
const noThoughtIds: ThoughtId[] = []

/** A selector that retrieves thoughts from a context and performs other functions like sorting or filtering. */
type GetThoughts = (state: State, context: Context) => Thought[]

/** A selector that retrieves thoughts from a context and performs other functions like sorting or filtering. */
type GetThoughtsById = (state: State, id: ThoughtId) => Thought[]

/** Returns true if the child is not hidden due to being a function or having the =hidden attribute. */
export const isChildVisible = _.curry((state: State, child: Thought) => {
  return !isFunction(child.value) && !hasChild(state, child.id, '=hidden')
})

/** Returns the thoughts for the given thought id. */
export const getAllChildrenById = (state: State, thoughtId: ThoughtId): ThoughtId[] => {
  const children = getThoughtById(state, thoughtId)?.children
  return children?.length > 0 ? children : noThoughtIds
}

/** Returns the subthoughts (as Thoughts) of the given context unordered. If the subthoughts have not changed, returns the same object reference. */
export const getAllChildrenAsThoughts = (state: State, context: Context) => {
  const children = childIdsToThoughts(state, getAllChildren(state, context))
  return children.length === 0 ? noChildren : children
}

/** Returns the subthoughts (as Thoughts) of the given ThoughtId unordered. If the subthoughts have not changed, returns the same object reference. */
export const getAllChildrenAsThoughtsById = (state: State, id: ThoughtId) => {
  const children = childIdsToThoughts(state, getAllChildrenById(state, id))
  return children.length === 0 ? noChildren : children
}

/** Returns the subthoughts (as ThoughtIds) of the given context unordered. If the subthoughts have not changed, returns the same object reference. */
export const getAllChildren = (state: State, context: Context) => {
  const id = contextToThoughtId(state, context)
  return id ? getAllChildrenById(state, id) : noThoughtIds
}

/** Makes a getAllChildren function that only returns visible thoughts. */
const getVisibleThoughts = _.curry((getThoughtsFunction: GetThoughts, state: State, context: Context) => {
  const children = getThoughtsFunction(state, context)
  return state.showHiddenThoughts ? children : children.filter(isChildVisible(state))
})

/** Makes a getAllChildren function that only returns visible thoughts. */
const getVisibleThoughtsById = _.curry((getThoughtsFunction: GetThoughtsById, state: State, id: ThoughtId) => {
  const children = getThoughtsFunction(state, id)
  return state.showHiddenThoughts ? children : children.filter(isChildVisible(state))
})

/** Makes a getAllChildren function that only returns visible thoughts with cursor check. */
const getVisibleThoughtsWithCursorCheck = _.curry(
  (getThoughtsFunction: GetThoughts, state: State, path: SimplePath, context: Context) => {
    const children = getThoughtsFunction(state, context)
    // TODO: Curried function type check is not working prropely. Predicate function can have type as value.
    return state.showHiddenThoughts ? children : children.filter(isChildVisibleWithCursorCheck(state, path))
  },
)

/** Returns true if the context has any visible children. */
export const hasChildren = (state: State, context: Context) => {
  const children = getAllChildrenAsThoughts(state, context)
  return state.showHiddenThoughts ? children.length > 0 : children.some(isChildVisible(state))
}

/** Gets all visible children of a Context, unordered. */
export const getChildren = getVisibleThoughts(getAllChildrenAsThoughts)

/** Gets all visible children of an id, unordered. */
export const getChildrenById = getVisibleThoughtsById(getAllChildrenAsThoughtsById)

/** Gets all children of a Context sorted by rank or sort preference. */
export const getAllChildrenSorted = (state: State, context: Context) => {
  const getThoughtsFunction =
    getSortPreference(state, context).type === 'Alphabetical' ? getChildrenSortedAlphabetical : getChildrenRanked
  return getThoughtsFunction(state, context)
}

/** Gets all visible children of a Context sorted by rank or sort preference.
 * Note: It doesn't check if thought lies within the cursor path or is descendant of meta cursor.
 */
export const getChildrenSorted = getVisibleThoughts(getAllChildrenSorted)

/** Gets all visible children within a context sorted by rank or sort preference.
 * Note: It checks if thought lies within the cursor path or is descendant of meta cursor.
 */
export const getChildrenSortedWithCursorCheck = getVisibleThoughtsWithCursorCheck(getAllChildrenSorted)

/** Gets a list of all children of a context sorted by the given comparator function. */
const getChildrenSortedBy = (state: State, context: Context, compare: ComparatorFunction<Thought>) =>
  sort(getAllChildrenAsThoughts(state, context), compare)

/** Returns the absolute difference between to child ranks. */
const rankDiff = (a: Thought, b: Thought) => Math.abs(a?.rank - b?.rank)

/** Generates children sorted by their values. Sorts empty thoughts to their point of creation. */
const getChildrenSortedAlphabetical = (state: State, context: Context): Thought[] => {
  const comparatorFunction =
    getSortPreference(state, context).direction === 'Desc' ? compareThoughtDescending : compareThought
  const sorted = getChildrenSortedBy(state, context, comparatorFunction)
  const emptyIndex = sorted.findIndex(thought => !thought.value)
  return emptyIndex === -1 ? sorted : resortEmptyInPlace(sorted)
}

/** Re-sorts empty thoughts in a sorted array to their point of creation. */
const resortEmptyInPlace = (sorted: Thought[]): Thought[] => {
  if (sorted.length === 1) return sorted

  let emptyIndex = sorted.findIndex(child => !child.value)

  // for each empty thought, find the nearest thought according to rank, determine if it was created before or after, and then splice the empty thought back into the sorted array where it was created
  let sortedFinal = sorted
  const numEmpties = sorted.filter(child => !child.value).length
  let i = 0

  // eslint-disable-next-line fp/no-loops
  while (emptyIndex !== -1 && i++ < numEmpties) {
    // ignore empty thoughts that have an explicit sortOrder
    // sortOrder is set when editing a thought to the empty thought in order to preserve their sort order
    if (sorted[emptyIndex]?.sortValue) {
      // not sure why the linter fails here since emptyIndex and i are declared outside the loop
      // See: https://eslint.org/docs/rules/no-loop-func
      // eslint-disable-next-line no-loop-func
      emptyIndex = sortedFinal.findIndex((child, i) => i < emptyIndex && !child.value)
      continue
    }

    // add an index to each thought
    const sortedWithIndex = sortedFinal.map((child, i) => ({ ...child, i }))

    // remove the first empty thought
    const sortedNoEmpty = splice(sortedWithIndex, emptyIndex, 1)
    const empty = sortedWithIndex[emptyIndex]

    // find the nearest sibling to the empty thought
    // getRankBefore places the new thought closer its next sibling
    // getRankAfter places the new thought closer its previous sibling
    const nearestSibling = sortedNoEmpty.reduce((accum, child) => {
      const diffEmpty = rankDiff(empty, child)
      const diffMin = rankDiff(empty, accum)
      return diffEmpty < diffMin ? child : accum
    }, sortedNoEmpty[0])

    // determine whether the empty thought was created before or after
    const isEmptyBeforeNearest = empty.rank < nearestSibling.rank

    // calculate the new index and splice the empty thought into place
    const emptyIndexNew = nearestSibling.i + (isEmptyBeforeNearest ? -1 : 0)
    sortedFinal = splice(sortedNoEmpty, emptyIndexNew, 0, empty)

    // get the emptyIndex for the next iteration of the loop, ignoring empty thoughts that have already been spliced
    emptyIndex = sortedFinal.findIndex((child, i) => i < emptyIndexNew && !child.value)
  }

  return sortedFinal
}

/** Gets all children of a Context sorted by their ranking. Returns a new object reference even if the children have not changed. */
export const getChildrenRanked = (state: State, context: Context): Thought[] =>
  getChildrenSortedBy(state, context, compareByRank)

/** Gets all children of a context sorted by their ranking using thought id. Returns a new object reference even if the children have not changed. */
// @MIGRATION_TODO: Currently we are migrating to access by id instead of context.
export const getChildrenRankedById = (state: State, thoughtId: ThoughtId): Thought[] => {
  const allChildren = childIdsToThoughts(state, getAllChildrenById(state, thoughtId))
  return sort(allChildren, compareByRank)
}

/** Returns the first visible child of a context. */
export const firstVisibleChild = (state: State, context: Context) => getChildrenSorted(state, context)[0]

/** Returns the first visible child (with cursor check) of a context. */
export const firstVisibleChildWithCursorCheck = (state: State, path: SimplePath, context: Context) =>
  getChildrenSortedWithCursorCheck(state, path, context)[0]

/** Checks if a child lies within the cursor path. */
const isChildInCursor = (state: State, path: Path, child: Thought) => {
  const childPath = unroot([...path, child.id])
  return state.cursor && state.cursor[childPath.length - 1] === child.id
}

/** Check if the cursor is a meta attribute && the given Path is the descendant of the cursor.  */
const isDescendantOfMetaCursor = (state: State, path: Path): boolean => {
  if (!state.cursor) return false

  const { value: cursorValue } = getThoughtById(state, head(state.cursor))

  return isFunction(cursorValue) && isDescendantPath(path, state.cursor)
}

/** Checks if the child is visible or if the child lies within the cursor or is descendant of the meta cursor. */
const isChildVisibleWithCursorCheck = _.curry(
  (state: State, path: SimplePath, thought: Thought) =>
    state.showHiddenThoughts ||
    isChildVisible(state, thought) ||
    isChildInCursor(state, path, thought) ||
    isDescendantOfMetaCursor(state, thoughtToPath(state, thought.id)),
  3,
)

/** Checks if the child is created after latest absolute context toggle. */
const isCreatedAfterAbsoluteToggle = _.curry((state: State, child: ThoughtId | ThoughtContext) => {
  const thought = getThoughtById(state, child)
  return thought.lastUpdated && state.absoluteContextTime && thought.lastUpdated > state.absoluteContextTime
})

/**
 * Children filter predicate used for rendering.
 *
 * 1. Checks if the child is visible.
 * 2. Checks if child is within cursor.
 * 3. Checks if child is created after latest absolute context toggle if starting context is absolute.
 */
export const childrenFilterPredicate = _.curry((state: State, parentPath: SimplePath, child: Thought) => {
  return (
    isChildVisibleWithCursorCheck(state, parentPath, child) &&
    (!isAbsolute(state.rootContext) || isCreatedAfterAbsoluteToggle(state, child.id))
  )
}, 3)
