import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DefaultDialogFooter,
} from '../dialog'
import { Dispatcher } from '../dispatcher'
import { RepositoryWithGitHubRepository } from '../../models/repository'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { sendNonFatalException } from '../../lib/helpers/non-fatal-exception'
import { Account } from '../../models/account'
import { API } from '../../lib/api'
import { LinkButton } from '../lib/link-button'

interface ICreateForkDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: RepositoryWithGitHubRepository
  readonly account: Account
  readonly onDismissed: () => void
}

interface ICreateForkDialogState {
  readonly loading: boolean
  readonly error?: Error
}

/**
 * Dialog offering to make a fork of the given repository
 */
export class CreateForkDialog extends React.Component<
  ICreateForkDialogProps,
  ICreateForkDialogState
> {
  public constructor(props: ICreateForkDialogProps) {
    super(props)
    this.state = { loading: false }
  }
  /**
   *  Starts fork process on GitHub!
   */
  private onSubmit = async () => {
    this.setState({ loading: true })
    const { gitHubRepository } = this.props.repository
    const api = API.fromAccount(this.props.account)
    try {
      const fork = await api.forkRepository(
        gitHubRepository.owner.login,
        gitHubRepository.name
      )
      await this.props.dispatcher.convertRepositoryToFork(
        this.props.repository,
        fork
      )
      this.setState({ loading: false })
      this.props.onDismissed()
    } catch (e) {
      log.error(`Fork creation through API failed (${e})`)
      sendNonFatalException('forkCreation', e)
      this.setState({ error: e, loading: false })
    }
  }

  public render() {
    return (
      <Dialog
        title="Do you want to fork this repository?"
        onDismissed={this.props.onDismissed}
        onSubmit={this.state.error ? undefined : this.onSubmit}
        dismissable={!this.state.loading}
        loading={this.state.loading}
        type={this.state.error ? 'error' : 'normal'}
        key={this.props.repository.name}
        id="create-fork"
      >
        {this.state.error !== undefined ? (
          <CreateForkDialogError
            repository={this.props.repository}
            account={this.props.account}
            error={this.state.error}
          />
        ) : (
          <CreateForkDialogContent
            repository={this.props.repository}
            account={this.props.account}
            loading={this.state.loading}
          />
        )}
      </Dialog>
    )
  }
}

interface ICreateForkDialogContentProps {
  readonly repository: RepositoryWithGitHubRepository
  readonly account: Account
  readonly loading: boolean
}

/** Standard (non-error) message and buttons for `CreateForkDialog` */
const CreateForkDialogContent: React.SFC<
  ICreateForkDialogContentProps
> = props => (
  <>
    <DialogContent>
      {`It looks like you don’t have write access to `}
      <strong>{props.repository.gitHubRepository.fullName}</strong>
      {`. Do you want to make a fork of this repository at `}
      <strong>
        {`${props.account.login}/${props.repository.gitHubRepository.name}`}
      </strong>
      {` to continue?`}
    </DialogContent>
    <DialogFooter>
      <OkCancelButtonGroup
        destructive={true}
        okButtonText={
          __DARWIN__ ? 'Fork This Repository' : 'Fork this repository'
        }
        okButtonDisabled={props.loading}
        cancelButtonDisabled={props.loading}
      />
    </DialogFooter>
  </>
)

/** Error state message (and buttons) for `CreateForkDialog` */
interface ICreateForkDialogErrorProps {
  readonly repository: RepositoryWithGitHubRepository
  readonly account: Account
  readonly error: Error
}

const CreateForkDialogError: React.SFC<ICreateForkDialogErrorProps> = props => {
  const suggestion =
    props.repository.gitHubRepository.htmlURL !== null ? (
      <>
        {`You can try `}
        <LinkButton uri={props.repository.gitHubRepository.htmlURL}>
          creating the fork manually on GitHub
        </LinkButton>
        .
      </>
    ) : (
      undefined
    )
  return (
    <>
      <DialogContent>
        <div>
          {`Making your fork `}
          <strong>
            ${props.account.login}/${props.repository.gitHubRepository.name}
          </strong>
          {` failed. `}
          {suggestion}
        </div>
        <details>
          <summary>Error details</summary>
          <pre className="error">{props.error.message}</pre>
        </details>
      </DialogContent>
      <DefaultDialogFooter />
    </>
  )
}
