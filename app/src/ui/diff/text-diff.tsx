import * as React from 'react'
import { clipboard } from 'electron'
import { Editor, LineHandle, Doc } from 'codemirror'
import { Disposable } from 'event-kit'

import {
  DiffHunk,
  DiffLineType,
  DiffSelection,
  DiffLine,
} from '../../models/diff'
import {
  WorkingDirectoryFileChange,
  CommittedFileChange,
} from '../../models/status'

import { OcticonSymbol } from '../octicons'

import { IEditorConfigurationExtra } from './editor-configuration-extra'
import { DiffSyntaxMode, IDiffSyntaxModeSpec } from './diff-syntax-mode'
import { CodeMirrorHost } from './code-mirror-host'
import { DiffLineGutter } from './diff-line-gutter'
import {
  diffLineForIndex,
  findInteractiveDiffRange,
  lineNumberForDiffLine,
} from './diff-explorer'

import { ISelectionStrategy } from './selection/selection-strategy'
import { RangeSelection } from './selection/range-selection-strategy'
import { DragDropSelection } from './selection/drag-drop-selection-strategy'

import {
  getLineFilters,
  getFileContents,
  highlightContents,
} from './syntax-highlighting'
import { relativeChanges } from './changed-range'
import { Repository } from '../../models/repository'
import memoizeOne from 'memoize-one'
import { selectedLineClass, hoverCssClass } from './selection/selection'
import { arrayEquals } from '../../lib/equality'

/** The longest line for which we'd try to calculate a line diff. */
const MaxIntraLineDiffStringLength = 4096

// This is a custom version of the no-newline octicon that's exactly as
// tall as it needs to be (8px) which helps with aligning it on the line.
const narrowNoNewlineSymbol = new OcticonSymbol(
  16,
  8,
  'm 16,1 0,3 c 0,0.55 -0.45,1 -1,1 l -3,0 0,2 -3,-3 3,-3 0,2 2,0 0,-2 2,0 z M 8,4 C 8,6.2 6.2,8 4,8 1.8,8 0,6.2 0,4 0,1.8 1.8,0 4,0 6.2,0 8,1.8 8,4 Z M 1.5,5.66 5.66,1.5 C 5.18,1.19 4.61,1 4,1 2.34,1 1,2.34 1,4 1,4.61 1.19,5.17 1.5,5.66 Z M 7,4 C 7,3.39 6.81,2.83 6.5,2.34 L 2.34,6.5 C 2.82,6.81 3.39,7 4,7 5.66,7 7,5.66 7,4 Z'
)

type ChangedFile = WorkingDirectoryFileChange | CommittedFileChange

/**
 * Checks to see if any key parameters in the props object that are used
 * when performing highlighting has changed. This is used to determine
 * whether highlighting should abort in between asynchronous operations
 * due to some factor (like which file is currently selected) have changed
 * and thus rendering the in-flight highlighting data useless.
 */
function highlightParametersEqual(
  newProps: ITextDiffProps,
  prevProps: ITextDiffProps
) {
  if (newProps === prevProps) {
    return true
  }

  return (
    newProps.file.id === prevProps.file.id && newProps.text === prevProps.text
  )
}

interface ITextDiffProps {
  readonly repository: Repository
  readonly file: ChangedFile
  readonly readOnly: boolean
  readonly onIncludeChanged?: (diffSelection: DiffSelection) => void
  readonly text: string
  readonly hunks: ReadonlyArray<DiffHunk>
}

const defaultEditorOptions: IEditorConfigurationExtra = {
  lineNumbers: false,
  readOnly: true,
  showCursorWhenSelecting: false,
  cursorBlinkRate: -1,
  lineWrapping: true,
  mode: { name: DiffSyntaxMode.ModeName },
  // Make sure CodeMirror doesn't capture Tab (and Shift-Tab) and thus destroy tab navigation
  extraKeys: { Tab: false, 'Shift-Tab': false },
  scrollbarStyle: __DARWIN__ ? 'simple' : 'native',
  styleSelectedText: true,
  lineSeparator: '\n',
  specialChars: /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\ufeff]/,
  gutters: ['diff-gutter'],
}

export class TextDiff extends React.Component<ITextDiffProps, {}> {
  private codeMirror: Editor | null = null
  private hunkHighlightRange: { start: number; end: number } | null = null

  private getFormattedText = memoizeOne((text: string) => {
    // If the text looks like it could have been formatted using Windows
    // line endings (\r\n) we need to massage it a bit before we hand it
    // off to CodeMirror. That's because CodeMirror has two ways of splitting
    // lines, one is the built in which splits on \n, \r\n and \r. The last
    // one is important because that will match carriage return characters
    // inside a diff line. The other way is when consumers supply the
    // lineSeparator option. That option only takes a string meaning we can
    // either make it split on '\r\n', '\n' or '\r' but not what we would like
    // to do, namely '\r?\n'. We want to keep CR characters inside of a diff
    // line so that we can mark them using the specialChars attribute so
    // we convert all \r\n to \n and remove any trailing \r character.
    if (text.indexOf('\r') === -1) {
      return text
    }

    // Capture the \r if followed by (positive lookahead) a \n or
    // the end of the string. Note that this does not capture the \n.
    return text.replace(/\r(?=\n|$)/g, '')
  })

  private getCodeMirrorDocument = memoizeOne(
    (text: string, noNewlineIndicatorLines: ReadonlyArray<number>) => {
      const doc = new Doc(
        this.getFormattedText(text),
        { name: DiffSyntaxMode.ModeName },
        defaultEditorOptions.firstLineNumber,
        defaultEditorOptions.lineSeparator
      )

      for (const noNewlineLine of noNewlineIndicatorLines) {
        const pos = {
          line: noNewlineLine,
          ch: doc.getLine(noNewlineLine).length,
        }
        const widget = document.createElement('span')
        widget.title = 'No newline at end of file'

        var xmlns = 'http://www.w3.org/2000/svg'
        const svgElem = document.createElementNS(xmlns, 'svg')
        svgElem.setAttribute('aria-hidden', 'true')
        svgElem.setAttribute('version', '1.1')
        svgElem.setAttribute(
          'viewBox',
          `0 0 ${narrowNoNewlineSymbol.w} ${narrowNoNewlineSymbol.h}`
        )
        svgElem.classList.add('no-newline')
        const pathElem = document.createElementNS(xmlns, 'path')
        pathElem.setAttribute('d', narrowNoNewlineSymbol.d)
        pathElem.textContent = 'No newline at end of file'
        svgElem.appendChild(pathElem)

        widget.appendChild(svgElem)

        doc.setBookmark(pos, { widget })
      }

      return doc
    },
    (x, y) => {
      if (Array.isArray(x) && Array.isArray(y)) {
        return arrayEquals(x, y)
      }
      return x === y
    }
  )

  private getNoNewlineIndicatorLines = memoizeOne(
    (hunks: ReadonlyArray<DiffHunk>) => {
      let lines = new Array<number>()
      for (const hunk of hunks) {
        for (const line of hunk.lines) {
          if (line.noTrailingNewLine) {
            lines.push(lineNumberForDiffLine(line, hunks))
          }
        }
      }
      return lines
    }
  )

  /**
   * A mapping from CodeMirror line handles to disposables which, when disposed
   * cleans up any line gutter components and events associated with that line.
   * See renderLine for more information.
   */
  private readonly lineCleanup = new Map<any, Disposable>()

  /**
   *  a local cache of gutter elements, keyed by the row in the diff
   */
  private cachedGutterElements = new Map<number, DiffLineGutter>()

  /**
   * Maintain the current state of the user interacting with the diff gutter
   */
  private selection: ISelectionStrategy | null = null

  private async initDiffSyntaxMode() {
    const cm = this.codeMirror
    const file = this.props.file
    const hunks = this.props.hunks
    const repo = this.props.repository

    if (!cm) {
      return
    }

    // Store the current props to that we can see if anything
    // changes from underneath us as we're making asynchronous
    // operations that makes our data stale or useless.
    const propsSnapshot = this.props

    const lineFilters = getLineFilters(hunks)
    const contents = await getFileContents(repo, file, lineFilters)

    if (!highlightParametersEqual(this.props, propsSnapshot)) {
      return
    }

    const tsOpt = cm.getOption('tabSize')
    const tabSize = typeof tsOpt === 'number' ? tsOpt : 4

    const tokens = await highlightContents(contents, tabSize, lineFilters)

    if (!highlightParametersEqual(this.props, propsSnapshot)) {
      return
    }

    const spec: IDiffSyntaxModeSpec = {
      name: DiffSyntaxMode.ModeName,
      hunks: this.props.hunks,
      oldTokens: tokens.oldTokens,
      newTokens: tokens.newTokens,
    }

    cm.setOption('mode', spec)
  }

  private dispose() {
    this.codeMirror = null

    this.lineCleanup.forEach(disposable => disposable.dispose())
    this.lineCleanup.clear()

    document.removeEventListener('mouseup', this.onDocumentMouseUp)
  }

  /**
   * start a selection gesture based on the current interation
   */
  private startSelection = (
    file: WorkingDirectoryFileChange,
    hunks: ReadonlyArray<DiffHunk>,
    index: number,
    isRangeSelection: boolean
  ) => {
    const snapshot = file.selection
    const selected = snapshot.isSelected(index)
    const desiredSelection = !selected

    if (isRangeSelection) {
      const range = findInteractiveDiffRange(hunks, index)
      if (!range) {
        console.error('unable to find range for given line in diff')
        return
      }

      this.selection = new RangeSelection(
        range.start,
        range.end,
        desiredSelection,
        snapshot
      )
    } else {
      this.selection = new DragDropSelection(index, desiredSelection, snapshot)
    }

    this.selection.paint(this.cachedGutterElements)
    document.addEventListener('mouseup', this.onDocumentMouseUp, { once: true })
  }

  private cancelSelection = () => {
    this.selection = null
  }

  private onDocumentMouseUp = (ev: MouseEvent) => {
    ev.preventDefault()

    if (this.codeMirror === null || this.selection === null) {
      return this.cancelSelection()
    }

    // A range selection is when the user clicks on the "hunk handle"
    // which is a hit area spanning 20 or so pixels on either side of
    // the gutter border, extending into the text area. We capture the
    // mouse down event on that hunk handle and for the mouse up event
    // we need to make sure the user is still within that hunk handle
    // section and in the correct range.
    if (this.selection instanceof RangeSelection) {
      // Is the pointer over something that might be a hunk handle?
      if (ev.target === null || !(ev.target instanceof HTMLElement)) {
        return this.cancelSelection()
      }

      // Is it a hunk handle?
      if (!ev.target.classList.contains('hunk-handle')) {
        return this.cancelSelection()
      }

      const { start, end } = this.selection
      const lineNumber = this.codeMirror.lineAtHeight(ev.y)

      // Is the pointer over the same range (i.e hunk) that the
      // selection was originally started from?
      if (lineNumber < start || lineNumber > end) {
        return this.cancelSelection()
      }
    }

    this.endSelection()
  }

  /**
   * complete the selection gesture and apply the change to the diff
   */
  private endSelection = () => {
    if (!this.props.onIncludeChanged || !this.selection) {
      return
    }

    this.props.onIncludeChanged(this.selection.done())

    // operation is completed, clean this up
    this.selection = null
  }

  private isSelectionEnabled = () => {
    return this.selection == null
  }

  private onGutterClick = (
    cm: Editor,
    line: number,
    gutter: string,
    clickEvent: Event
  ) => {
    console.log(`${gutter} clicked on line ${line}`)
    const { file } = this.props

    if (file instanceof WorkingDirectoryFileChange) {
      if (this.props.onIncludeChanged) {
        this.props.onIncludeChanged(
          file.selection.withToggleLineSelection(line)
        )
      }
    }
  }

  private getAndStoreCodeMirrorInstance = (cmh: CodeMirrorHost | null) => {
    const newEditor = cmh === null ? null : cmh.getEditor()
    if (newEditor === null && this.codeMirror !== null) {
      this.codeMirror.off('gutterClick', this.onGutterClick)
    }

    this.codeMirror = newEditor

    if (this.codeMirror !== null) {
      this.codeMirror.on('gutterClick', this.onGutterClick)
      this.codeMirror.on('gutterClick', this.onGutterClick)
    }
  }

  private onCopy = (editor: Editor, event: Event) => {
    event.preventDefault()

    // Remove the diff line markers from the copied text. The beginning of the
    // selection might start within a line, in which case we don't have to trim
    // the diff type marker. But for selections that span multiple lines, we'll
    // trim it.
    const doc = editor.getDoc()
    const lines = doc.getSelections()
    const selectionRanges = doc.listSelections()
    const lineContent: Array<string> = []

    for (let i = 0; i < lines.length; i++) {
      const range = selectionRanges[i]
      const content = lines[i]
      const contentLines = content.split('\n')
      for (const [i, line] of contentLines.entries()) {
        if (i === 0 && range.head.ch > 0) {
          lineContent.push(line)
        } else {
          lineContent.push(line.substr(1))
        }
      }

      const textWithoutMarkers = lineContent.join('\n')
      clipboard.writeText(textWithoutMarkers)
    }
  }

  private markIntraLineChanges(doc: Doc, hunks: ReadonlyArray<DiffHunk>) {
    for (const hunk of hunks) {
      const additions = hunk.lines.filter(l => l.type === DiffLineType.Add)
      const deletions = hunk.lines.filter(l => l.type === DiffLineType.Delete)
      if (additions.length !== deletions.length) {
        continue
      }

      for (let i = 0; i < additions.length; i++) {
        const addLine = additions[i]
        const deleteLine = deletions[i]
        if (
          addLine.text.length > MaxIntraLineDiffStringLength ||
          deleteLine.text.length > MaxIntraLineDiffStringLength
        ) {
          continue
        }

        const changeRanges = relativeChanges(
          addLine.content,
          deleteLine.content
        )
        const addRange = changeRanges.stringARange
        if (addRange.length > 0) {
          const addLineNumber = lineNumberForDiffLine(addLine, hunks)
          if (addLineNumber > -1) {
            const addFrom = {
              line: addLineNumber,
              ch: addRange.location + 1,
            }
            const addTo = {
              line: addLineNumber,
              ch: addRange.location + addRange.length + 1,
            }
            doc.markText(addFrom, addTo, { className: 'cm-diff-add-inner' })
          }
        }

        const deleteRange = changeRanges.stringBRange
        if (deleteRange.length > 0) {
          const deleteLineNumber = lineNumberForDiffLine(deleteLine, hunks)
          if (deleteLineNumber > -1) {
            const deleteFrom = {
              line: deleteLineNumber,
              ch: deleteRange.location + 1,
            }
            const deleteTo = {
              line: deleteLineNumber,
              ch: deleteRange.location + deleteRange.length + 1,
            }
            doc.markText(deleteFrom, deleteTo, {
              className: 'cm-diff-delete-inner',
            })
          }
        }
      }
    }
  }

  private onSwapDoc = (cm: Editor, oldDoc: Doc) => {
    this.markIntraLineChanges(cm.getDoc(), this.props.hunks)
  }

  private onViewportChange = (cm: Editor, from: number, to: number) => {
    const doc = cm.getDoc()
    const batchedOps = new Array<Function>()

    doc.eachLine(from, to, line => {
      const lineNumber = doc.getLineNumber(line)

      if (lineNumber === null) {
        return
      }

      const diffLine = diffLineForIndex(this.props.hunks, lineNumber)

      if (diffLine === null) {
        return
      }

      let marker: HTMLElement | null = null
      const lineInfo = cm.lineInfo(line)

      if (lineInfo.gutterMarkers && 'diff-gutter' in lineInfo.gutterMarkers) {
        marker = lineInfo.gutterMarkers['diff-gutter'] as HTMLElement
        this.updateGutterMarker(marker, lineNumber, line, diffLine)
      } else {
        batchedOps.push(() => {
          marker = this.createGutterMarker(lineNumber, line, diffLine)
          cm.setGutterMarker(line, 'diff-gutter', marker)
        })
      }
    })

    // Updating a gutter marker doesn't affect layout or rendering
    // as far as CodeMirror is concerned so we only run an operation
    // (which will trigger a CodeMirror refresh) when we have gutter
    // markers to create.
    if (batchedOps.length > 0) {
      cm.operation(() => batchedOps.forEach(x => x()))
    }
  }

  private getGutterLineClassNameInfo(
    index: number,
    diffLine: DiffLine
  ): { [className: string]: boolean } {
    let isIncluded = false
    const isIncludeable = diffLine.isIncludeableLine()

    if (this.props.file instanceof WorkingDirectoryFileChange) {
      isIncluded = isIncludeable && this.props.file.selection.isSelected(index)
    }

    const { type } = diffLine

    const hover =
      this.hunkHighlightRange === null
        ? false
        : index >= this.hunkHighlightRange.start &&
          index <= this.hunkHighlightRange.end

    return {
      'diff-line-gutter': true,
      'diff-add': type === DiffLineType.Add,
      'diff-delete': type === DiffLineType.Delete,
      'diff-context': type === DiffLineType.Context,
      'diff-hunk': type === DiffLineType.Hunk,
      'read-only': this.props.readOnly,
      includeable: isIncludeable && !this.props.readOnly,
      [selectedLineClass]: isIncluded,
      [hoverCssClass]: hover,
    }
  }

  private createGutterMarker(
    index: number,
    line: LineHandle,
    diffLine: DiffLine
  ): HTMLElement | null {
    const marker = document.createElement('div')
    marker.className = 'diff-line-gutter'

    const oldLineNumber = document.createElement('div')
    oldLineNumber.textContent =
      diffLine.oldLineNumber === null ? '' : `${diffLine.oldLineNumber}`
    oldLineNumber.classList.add('diff-line-number', 'before')
    marker.appendChild(oldLineNumber)

    const newLineNumber = document.createElement('div')
    newLineNumber.textContent =
      diffLine.newLineNumber === null ? '' : `${diffLine.newLineNumber}`
    newLineNumber.classList.add('diff-line-number', 'after')
    marker.appendChild(newLineNumber)

    const hunkHandle = document.createElement('div')
    hunkHandle.addEventListener('mouseenter', this.onHunkHandleMouseEnter)
    hunkHandle.addEventListener('mouseleave', this.onHunkHandleMouseLeave)
    hunkHandle.addEventListener('mousedown', this.onHunkHandleMouseDown)
    hunkHandle.classList.add('hunk-handle')
    marker.appendChild(hunkHandle)

    this.updateGutterMarker(marker, index, line, diffLine)

    return marker
  }

  private updateGutterMarker(
    marker: HTMLElement,
    index: number,
    line: LineHandle,
    diffLine: DiffLine
  ) {
    const classNameInfo = this.getGutterLineClassNameInfo(index, diffLine)
    for (const [className, include] of Object.entries(classNameInfo)) {
      if (include) {
        marker.classList.add(className)
      } else {
        marker.classList.remove(className)
      }
    }
    if (!this.props.readOnly && diffLine.isIncludeableLine()) {
      marker.setAttribute('role', 'button')
    } else {
      marker.removeAttribute('role')
    }
  }

  private onHunkHandleMouseEnter = (ev: MouseEvent) => {
    if (this.codeMirror === null || this.props.readOnly) {
      return
    }
    const lineNumber = this.codeMirror.lineAtHeight(ev.y)

    const diffLine = diffLineForIndex(this.props.hunks, lineNumber)

    if (!diffLine || !diffLine.isIncludeableLine()) {
      return
    }

    const range = findInteractiveDiffRange(this.props.hunks, lineNumber)

    this.hunkHighlightRange = range
    console.log('hunk handle mouse enter')
    this.updateViewport()
  }

  private updateViewport() {
    if (!this.codeMirror) {
      return
    }
    const { from, to } = this.codeMirror.getViewport()
    this.onViewportChange(this.codeMirror, from, to)
  }

  private onHunkHandleMouseLeave = (ev: MouseEvent) => {
    console.log('hunk handle mouse leave')
    this.hunkHighlightRange = null
    this.updateViewport()
  }

  private onHunkHandleMouseDown = (ev: MouseEvent) => {
    if (!this.codeMirror) {
      return
    }

    if (!(this.props.file instanceof WorkingDirectoryFileChange)) {
      return
    }

    const lineNumber = this.codeMirror.lineAtHeight(ev.y)

    ev.preventDefault()
    this.startSelection(this.props.file, this.props.hunks, lineNumber, true)
  }

  public componentWillUnmount() {
    this.dispose()
  }

  public componentDidUpdate(
    prevProps: ITextDiffProps,
    prevState: {},
    // tslint:disable-next-line:react-proper-lifecycle-methods
    snapshot: CodeMirror.ScrollInfo | null
  ) {
    if (this.codeMirror === null) {
      return
    }

    // No need to keep potentially tons of diff gutter DOM
    // elements around in memory when we're switching files.
    if (this.props.file.id !== prevProps.file.id) {
      this.codeMirror.clearGutter('diff-gutter')
    }

    if (this.props.file instanceof WorkingDirectoryFileChange) {
      if (
        !(prevProps instanceof WorkingDirectoryFileChange) ||
        this.props.file.selection !== prevProps.selection
      ) {
        // If the text has changed the gutters will be recreated
        // regardless but if it hasn't then we'll need to update
        // the viewport.
        if (this.props.text === prevProps.text) {
          const { from, to } = this.codeMirror.getViewport()
          this.onViewportChange(this.codeMirror, from, to)
        }
      }
    }

    if (snapshot !== null) {
      this.codeMirror.scrollTo(undefined, snapshot.top)
    }
  }

  public getSnapshotBeforeUpdate(prevProps: ITextDiffProps) {
    if (this.codeMirror) {
      if (this.props.file.id === prevProps.file.id) {
        return this.codeMirror.getScrollInfo()
      }
    }
    return null
  }

  public componentDidMount() {
    this.initDiffSyntaxMode()
  }

  public render() {
    const doc = this.getCodeMirrorDocument(
      this.props.text,
      this.getNoNewlineIndicatorLines(this.props.hunks)
    )

    return (
      <CodeMirrorHost
        className="diff-code-mirror"
        value={doc}
        options={defaultEditorOptions}
        isSelectionEnabled={this.isSelectionEnabled}
        onSwapDoc={this.onSwapDoc}
        onViewportChange={this.onViewportChange}
        ref={this.getAndStoreCodeMirrorInstance}
        onCopy={this.onCopy}
      />
    )
  }
}
