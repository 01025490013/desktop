import * as React from 'react'

import { Account } from '../../models/account'
import { DialogContent } from '../dialog'
import { TextBox } from '../lib/text-box'
import { Row } from '../lib/row'
import { Button } from '../lib/button'
import { Loading } from '../lib/loading'
import { Octicon } from '../octicons'
import { FilterList } from '../lib/filter-list'
import { IAPIRepository } from '../../lib/api'
import { IFilterListGroup } from '../lib/filter-list'
import { IMatches } from '../../lib/fuzzy-find'
import {
  IClonableRepositoryListItem,
  groupRepositories,
  YourRepositoriesIdentifier,
} from './group-repositories'
import { HighlightText } from '../lib/highlight-text'

interface ICloneGithubRepositoryProps {
  /** The account to clone from. */
  readonly account: Account

  /** The path to clone to. */
  readonly path: string

  /** Called when the destination path changes. */
  readonly onPathChanged: (path: string) => void

  /**
   * Called when the user should be prompted to choose a destination directory.
   */
  readonly onChooseDirectory: () => Promise<string | undefined>

  /** Called when a repository is selected. */
  readonly onGitHubRepositorySelected: (url: string) => void

  readonly repositories: ReadonlyArray<IAPIRepository> | null
  readonly loading: boolean
  readonly onRefreshRepositories: (account: Account) => void
  readonly filterText: string
  readonly onFilterTextChanged: (filterText: string) => void
}

interface ICloneGithubRepositoryState {
  /** The list of clonable repositories. */
  readonly repositories: ReadonlyArray<
    IFilterListGroup<IClonableRepositoryListItem>
  >

  /** The currently selected item. */
  readonly selectedItem: IClonableRepositoryListItem | null
}

const RowHeight = 31

export class CloneGithubRepository extends React.Component<
  ICloneGithubRepositoryProps,
  ICloneGithubRepositoryState
> {
  public constructor(props: ICloneGithubRepositoryProps) {
    super(props)

    this.state = {
      repositories: [],
      selectedItem: null,
    }
  }

  public componentDidMount() {
    if (this.props.repositories === null) {
      this.props.onRefreshRepositories(this.props.account)
    } else {
      this.loadRepositories()
    }
  }

  public componentDidUpdate(prevProps: ICloneGithubRepositoryProps) {
    if (prevProps.repositories !== this.props.repositories) {
      this.loadRepositories()
    }
  }

  private async loadRepositories() {
    const repositories =
      this.props.repositories === null || this.props.repositories.length === 0
        ? []
        : groupRepositories(this.props.repositories, this.props.account.login)

    this.setState({ repositories })
  }

  public render() {
    return (
      <DialogContent className="clone-github-repository-content">
        <Row>{this.renderRepositoryList()}</Row>

        <Row className="local-path-field">
          <TextBox
            value={this.props.path}
            label={__DARWIN__ ? 'Local Path' : 'Local path'}
            placeholder="repository path"
            onValueChanged={this.onPathChanged}
          />
          <Button onClick={this.props.onChooseDirectory}>Choose…</Button>
        </Row>
      </DialogContent>
    )
  }

  private renderRepositoryList() {
    if (this.props.loading) {
      return (
        <div className="clone-github-repo clone-loading">
          <Loading /> Loading repositories…
        </div>
      )
    }

    return (
      <FilterList<IClonableRepositoryListItem>
        className="clone-github-repo"
        rowHeight={RowHeight}
        selectedItem={this.state.selectedItem}
        renderItem={this.renderItem}
        renderGroupHeader={this.renderGroupHeader}
        onSelectionChanged={this.onSelectionChanged}
        invalidationProps={this.state.repositories}
        groups={this.state.repositories}
        filterText={this.props.filterText}
        onFilterTextChanged={this.props.onFilterTextChanged}
        renderNoItems={this.noMatchingRepositories}
      />
    )
  }

  private noMatchingRepositories = function() {
    return (
      <div className="no-results-found">
        Sorry, I can't find that repository.
      </div>
    )
  }

  private onSelectionChanged = (item: IClonableRepositoryListItem | null) => {
    this.setState({ selectedItem: item })
    this.props.onGitHubRepositorySelected(item != null ? item.url : '')
  }

  private onPathChanged = (path: string) => {
    this.props.onPathChanged(path)
  }

  private renderGroupHeader = (identifier: string) => {
    let header = identifier
    if (identifier === YourRepositoriesIdentifier) {
      header = __DARWIN__ ? 'Your Repositories' : 'Your repositories'
    }
    return (
      <div className="clone-repository-list-content clone-repository-list-group-header">
        {header}
      </div>
    )
  }

  private renderItem = (
    item: IClonableRepositoryListItem,
    matches: IMatches
  ) => {
    return (
      <div className="clone-repository-list-item">
        <Octicon className="icon" symbol={item.icon} />
        <div className="name" title={item.text[0]}>
          <HighlightText text={item.text[0]} highlight={matches.title} />
        </div>
      </div>
    )
  }
}
