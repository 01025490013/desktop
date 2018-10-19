import * as React from 'react'
import { join } from 'path'
import { Button } from '../lib/button'
import { ButtonGroup } from '../lib/button-group'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { Dispatcher } from '../../lib/dispatcher'
import { RepositorySectionTab, PopupType } from '../../lib/app-state'
import { Repository } from '../../models/repository'
import {
  WorkingDirectoryStatus,
  WorkingDirectoryFileChange,
  AppFileStatus,
} from '../../models/status'
import { Octicon, OcticonSymbol } from '../octicons'
import { Branch } from '../../models/branch'
import { createMergeCommit, abortMerge } from '../../lib/git'
import { PathText } from '../lib/path-text'

interface IMergeConflictsDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  readonly status: WorkingDirectoryStatus
  readonly onDismissed: () => void
  readonly openFileInExternalEditor: (path: string) => void
  readonly externalEditorName?: string
  readonly openRepositoryInShell: (repository: Repository) => void
  readonly currentBranch: Branch
  readonly comparisonBranch: Branch
}

const submitButtonString = 'Commit merge'
const cancelButtonString = 'Abort merge'

/**
 * Modal to tell the user their merge encountered conflicts
 */
export class MergeConflictsDialog extends React.Component<
  IMergeConflictsDialogProps,
  {}
> {
  /**
   *  commits the merge displays the repository changes tab and dismisses the modal
   */
  private onSubmit = async () => {
    await createMergeCommit(this.props.repository, this.props.status.files)
    this.props.dispatcher.changeRepositorySection(
      this.props.repository,
      RepositorySectionTab.Changes
    )
    this.props.onDismissed()
  }

  /**
   *  dismisses the modal and shows the abort merge warning modal
   */
  private onCancel = async () => {
    const anyResolvedFiles = this.getUnmergedFiles().some(
      f => f.status === AppFileStatus.Resolved
    )
    if (!anyResolvedFiles) {
      await abortMerge(this.props.repository)
      this.props.onDismissed()
    } else {
      this.props.onDismissed()
      this.props.dispatcher.showPopup({
        type: PopupType.AbortMerge,
        repository: this.props.repository,
      })
    }
  }

  private titleString(currentBranchName: string, comparisonBranchName: string) {
    return `Resolve conflicts before merging ${comparisonBranchName} into ${currentBranchName}`
  }

  private editorButtonString(editorName: string | undefined) {
    const defaultEditorString = 'editor'
    return `Open in ${editorName || defaultEditorString}`
  }

  private renderShellLink(openThisRepositoryInShell: () => void): JSX.Element {
    return (
      <div className="cli-link">
        You can also{' '}
        <a onClick={openThisRepositoryInShell}>open the command line</a> to
        resolve
      </div>
    )
  }

  private renderResolvedFile(path: string): JSX.Element {
    return (
      <li className="unmerged-file-status-resolved">
        <Octicon symbol={OcticonSymbol.fileCode} className="file-octicon" />
        <div className="column-left">
          <PathText path={path} />
          <div className="file-conflicts-status">No conflicts remaining</div>
        </div>
        <div className="green-circle">
          <Octicon symbol={OcticonSymbol.check} />
        </div>
      </li>
    )
  }

  private renderConflictedFile(
    path: string,
    conflicts: number,
    editorName: string | undefined,
    onOpenEditorClick: () => void
  ): JSX.Element {
    const humanReadableConflicts = Math.ceil(conflicts / 3)
    const message =
      humanReadableConflicts === 1
        ? `1 conflict`
        : `${humanReadableConflicts} conflicts`
    return (
      <li className="unmerged-file-status-conflicts">
        <Octicon symbol={OcticonSymbol.fileCode} className="file-octicon" />
        <div className="column-left">
          <div className="file-path">{path}</div>
          <div className="file-conflicts-status">{message}</div>
        </div>
        <Button onClick={onOpenEditorClick}>
          {this.editorButtonString(editorName)}
        </Button>
      </li>
    )
  }

  private renderUnmergedFile(
    file: WorkingDirectoryFileChange,
    editorName: string | undefined,
    repositoryPath: string
  ): JSX.Element | null {
    switch (file.status) {
      case AppFileStatus.Resolved:
        return this.renderResolvedFile(file.path)
      case AppFileStatus.Conflicted:
        return this.renderConflictedFile(
          file.path,
          file.conflictMarkers,
          editorName,
          () =>
            this.props.openFileInExternalEditor(join(repositoryPath, file.path))
        )
      default:
        return null
    }
  }

  private renderUnmergedFiles(
    files: Array<WorkingDirectoryFileChange>,
    editorName: string | undefined,
    repositoryPath: string
  ) {
    return (
      <ul className="unmerged-file-statuses">
        {files.map(f => this.renderUnmergedFile(f, editorName, repositoryPath))}
      </ul>
    )
  }

  private getUnmergedFiles() {
    return this.props.status.files.filter(
      file =>
        file.status === AppFileStatus.Conflicted ||
        file.status === AppFileStatus.Resolved
    )
  }

  private renderUnmergedFilesSummary(unmergedFiles: number) {
    // localization, it burns :vampire:
    const message =
      unmergedFiles === 1
        ? `1 conflicted file`
        : `${unmergedFiles} conflicted files`
    return <h3 className="summary">{message}</h3>
  }

  public render() {
    const unmergedFiles = this.getUnmergedFiles()
    const anyConflictedFiles = unmergedFiles.some(
      f => f.status === AppFileStatus.Conflicted
    )
    const titleString = this.titleString(
      this.props.currentBranch.name,
      this.props.comparisonBranch.name
    )
    const tooltipString = anyConflictedFiles
      ? 'Resolve all changes before merging'
      : undefined
    const openThisRepositoryInShell = () =>
      this.props.openRepositoryInShell(this.props.repository)
    return (
      <Dialog
        id="merge-conflicts-list"
        title={titleString}
        dismissable={false}
        onDismissed={this.onCancel}
        onSubmit={this.onSubmit}
      >
        <DialogContent>
          {this.renderUnmergedFilesSummary(unmergedFiles.length)}
          {this.renderUnmergedFiles(
            unmergedFiles,
            this.props.externalEditorName,
            this.props.repository.path
          )}
          {this.renderShellLink(openThisRepositoryInShell)}
        </DialogContent>
        <DialogFooter>
          <ButtonGroup>
            <Button
              type="submit"
              disabled={anyConflictedFiles}
              tooltip={tooltipString}
            >
              {submitButtonString}
            </Button>
            <Button onClick={this.onCancel}>{cancelButtonString}</Button>
          </ButtonGroup>
        </DialogFooter>
      </Dialog>
    )
  }
}
