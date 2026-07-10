"""CLI commands for Claude Reviewer."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table

from . import database as db
from .git_ops import GitOps
from .models import (
    Comment,
    CommentReply,
    PRStatus,
    PullRequest,
    RepoConversation,
    RepoConversationMessage,
)

console = Console()


def print_comment(
    c: Comment, replies: list[CommentReply] | None = None, indent: str = "  "
) -> None:
    """Print a single comment as a scannable location header + indented content.

    highlight=False avoids Rich's automatic ReprHighlighter, which otherwise
    bolds numbers/brackets/parens inside the file path and content, producing
    jumbled, inconsistent coloring.
    """
    side_note = " [dim]\\[old-side][/dim]" if c.line_type == "old" else ""
    commit_note = f" [dim]\\[{c.commit_sha[:7]}][/dim]" if c.commit_sha else ""
    resolved_note = " [dim]\\[resolved][/dim]" if c.resolved else ""
    line_ref = (
        f"{c.line_number}-{c.end_line_number}"
        if c.end_line_number != c.line_number
        else str(c.line_number)
    )
    console.print(
        f"{indent}[cyan]{c.file_path}:{line_ref}[/cyan]{side_note}{commit_note}{resolved_note}  "
        f"[dim]· {c.uuid}[/dim]",
        highlight=False,
    )
    console.print(f"{indent}  {c.content}", highlight=False)
    for reply in replies or []:
        author_color = "green" if reply.author == "claude" else "blue"
        console.print(
            f"{indent}  [{author_color}]↳ {reply.author}:[/{author_color}] {reply.content}",
            highlight=False,
        )


def get_review_url(pr_uuid: str | None = None, port: int = 41729) -> str:
    """Generate the review URL for a PR, or the dashboard URL if no PR is given."""
    host = os.environ.get("CLAUDE_REVIEWER_HOST", "localhost")
    base = f"http://{host}:{port}"
    return f"{base}/prs/{pr_uuid}" if pr_uuid else base


@click.group()
@click.version_option()
def main() -> None:
    """Claude Reviewer - Local PR review system for Claude Code."""
    # Initialize database on first run
    db.init_db()


@main.command()
@click.option("--title", "-t", required=True, help="PR title")
@click.option("--description", "-d", default="", help="PR description")
@click.option("--base", "-b", default=None, help="Base branch (default: auto-detect main/master)")
@click.option("--head", "-h", default=None, help="Head branch (default: current branch)")
@click.option("--repo", "-r", default=".", help="Path to git repository")
@click.option("--port", "-p", default=41729, help="Port for review URL (default: 41729)")
def create(
    title: str,
    description: str,
    base: str | None,
    head: str | None,
    repo: str,
    port: int,
) -> None:
    """Create a new PR for review."""
    try:
        repo_path = Path(repo).resolve()
        git = GitOps(str(repo_path))

        # Get head branch (default to current)
        head_ref = head or git.get_current_branch()

        # Auto-detect base branch if not provided
        if not base:
            # Try to find the default branch
            possible_defaults = ["main", "master", "trunk", "development"]

            # 1. Try to get semantic default from remote
            remote_info = subprocess.run(
                ["git", "remote", "show", "origin"],
                cwd=repo_path,
                capture_output=True,
                text=True,
                check=False,  # Don't raise on error, just continue to next method
            ).stdout
            for line in remote_info.split("\n"):
                if "HEAD branch:" in line:
                    remote_default = line.split(":")[1].strip()
                    if remote_default:
                        base = remote_default
                        break

            # 2. If remote detection failed, check local branches for common names
            if not base:
                local_branches = git.get_branches()
                for name in possible_defaults:
                    if name in local_branches:
                        base = name
                        break

            # 3. Fallback
            if not base:
                base = "main"

            console.print(f"[dim]Auto-detected base branch: {base}[/dim]")

        if head_ref == base:
            console.print(
                f"[red]Error: Head branch '{head_ref}' is the same as base branch '{base}'[/red]"
            )
            sys.exit(1)

        # Get commit SHAs
        base_commit = git.get_commit_sha(base)
        head_commit = git.get_commit_sha(head_ref)

        # Get diff
        diff = git.get_diff(base, head_ref)
        if not diff.strip():
            console.print(f"[yellow]Warning: No changes between {base} and {head_ref}[/yellow]")

        # Create PR in database
        pr_uuid = db.create_pr(
            repo_path=str(repo_path),
            title=title,
            description=description,
            base_ref=base,
            head_ref=head_ref,
            base_commit=base_commit,
            head_commit=head_commit,
            diff=diff,
        )

        review_url = get_review_url(pr_uuid, port)

        # Check if web UI is running and add appropriate message
        web_ui_status = ""
        if not is_web_ui_running(port):
            web_ui_status = (
                "\n\n[yellow]⚠ Web UI is not running.[/yellow]\n"
                "[dim]Start it with: claude-reviewer serve[/dim]"
            )

        console.print(
            Panel(
                f"[green]PR #{pr_uuid} created successfully[/green]\n\n"
                f"Title: {title}\n"
                f"Branch: {head_ref} -> {base}\n"
                f"\n[bold]Review URL:[/bold] {review_url}"
                f"{web_ui_status}",
                title="New PR Created",
            )
        )

    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@main.command()
@click.argument("pr_id")
def status(pr_id: str) -> None:
    """Check the status of a PR."""
    pr = db.get_pr_by_uuid(pr_id)
    if not pr:
        console.print(f"[red]Error: PR '{pr_id}' not found[/red]")
        sys.exit(1)

    # GitHub-style status colors
    status_colors = {
        PRStatus.PENDING: "#d29922",  # GitHub yellow
        PRStatus.APPROVED: "#3fb950",  # GitHub green
        PRStatus.CHANGES_REQUESTED: "#f85149",  # GitHub red
        PRStatus.MERGED: "#a371f7",  # GitHub purple
        PRStatus.CLOSED: "#8b949e",  # GitHub gray
    }

    color = status_colors.get(pr.status, "white")
    console.print(f"[{color}]{pr.status.value}[/{color}]")


@main.command()
@click.argument("pr_id")
@click.option(
    "--format", "-f", "output_format", type=click.Choice(["text", "json"]), default="text"
)
@click.option("--unresolved", "-u", is_flag=True, help="Show only unresolved comments")
def comments(pr_id: str, output_format: str, unresolved: bool) -> None:
    """Get comments for a PR with file/line references.

    Shows both review summaries (from Submit Review) and inline comments.
    """
    pr = db.get_pr_by_uuid(pr_id)
    if not pr:
        console.print(f"[red]Error: PR '{pr_id}' not found[/red]")
        sys.exit(1)

    reviews = db.get_reviews(pr_id)
    comments_with_replies = db.get_comments_with_replies(pr_id, unresolved_only=unresolved)

    if output_format == "json":
        output = {
            "pr_id": pr_id,
            "reviews": [
                {
                    "action": r["action"],
                    "summary": r["summary"],
                    "created_at": r["created_at"],
                }
                for r in reviews
            ],
            "comments": [
                {
                    "uuid": c.uuid,
                    "file": c.file_path,
                    "line": c.line_number,
                    "end_line": c.end_line_number,
                    "commit_sha": c.commit_sha,
                    "line_type": c.line_type,
                    "text": c.content,
                    "resolved": c.resolved,
                    "replies": [{"author": r.author, "text": r.content} for r in replies],
                }
                for c, replies in comments_with_replies
            ],
        }
        print(json.dumps(output, indent=2))
    else:
        # Show review summaries first (these are always important)
        if reviews:
            console.print("[bold]Review Summary:[/bold]")
            for r in reviews:
                action_color = "green" if r["action"] == "approve" else "yellow"
                action_label = "Approved" if r["action"] == "approve" else "Changes Requested"
                console.print(f"  [{action_color}]{action_label}[/{action_color}]", end="")
                if r["summary"]:
                    console.print(f": {r['summary']}")
                else:
                    console.print()
            console.print()

        # Show inline comments
        if comments_with_replies:
            console.print("[bold]Inline Comments:[/bold]\n")
            for c, replies in comments_with_replies:
                print_comment(c, replies)
                console.print()
        elif not reviews:
            console.print("[dim]No comments or reviews found[/dim]")


@main.command("list")
@click.option("--repo", "-r", default=None, help="Filter by repository path")
@click.option(
    "--status",
    "-s",
    type=click.Choice(["pending", "approved", "changes_requested", "merged", "closed"]),
    default=None,
)
@click.option("--limit", "-l", default=20, help="Maximum number of PRs to show")
@click.option("--all", "-a", "show_all", is_flag=True, help="Show PRs from all repositories")
def list_prs(repo: str | None, status: str | None, limit: int, show_all: bool) -> None:
    """List PRs.

    By default, shows PRs for the current repository only.
    Use --all to show PRs from all repositories.
    """
    status_filter = PRStatus(status) if status else None

    # Determine repo path filter
    repo_path = None
    if repo:
        repo_path = str(Path(repo).resolve())
    elif not show_all:
        # Try to detect current git repo scope
        cwd = Path.cwd()
        # Use simple git check without invoking subprocess if possible or just let it fail
        # But we need to be safe if git is not installed or not in repo
        try:
            git_root = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=cwd,
                capture_output=True,
                text=True,
                check=False,
            ).stdout.strip()

            if git_root:
                repo_path = str(Path(git_root).resolve())
        except FileNotFoundError:
            # Git executable not found
            pass

    prs = db.list_prs(repo_path=repo_path, status=status_filter, limit=limit)

    if not prs:
        if repo_path:
            console.print(f"[dim]No PRs found for repository: {repo_path}[/dim]")
            console.print("[dim]Use --all to see PRs from other repositories[/dim]")
        else:
            console.print("[dim]No PRs found[/dim]")
        return

    title_text = (
        "Pull Requests" if show_all or not repo_path else f"Pull Requests ({Path(repo_path).name})"
    )
    table = Table(title=title_text)
    table.add_column("ID", style="cyan")
    table.add_column("Title", style="white")
    table.add_column("Branch", style="dim")
    table.add_column("Status", style="bold")
    table.add_column("Updated", style="dim")

    # GitHub-style status colors
    status_colors = {
        PRStatus.PENDING: "#d29922",  # GitHub yellow
        PRStatus.APPROVED: "#3fb950",  # GitHub green
        PRStatus.CHANGES_REQUESTED: "#f85149",  # GitHub red
        PRStatus.MERGED: "#a371f7",  # GitHub purple
        PRStatus.CLOSED: "#8b949e",  # GitHub gray
    }

    for pr in prs:
        color = status_colors.get(pr.status, "white")
        table.add_row(
            pr.uuid,
            pr.title[:40] + ("..." if len(pr.title) > 40 else ""),
            pr.head_ref,
            f"[{color}]{pr.status.value}[/{color}]",
            str(pr.updated_at)[:16] if pr.updated_at else "-",
        )

    console.print(table)


@main.command()
@click.argument("pr_id")
def close(pr_id: str) -> None:
    """Close a PR without merging."""
    pr = db.get_pr_by_uuid(pr_id)
    if not pr:
        console.print(f"[red]Error: PR '{pr_id}' not found[/red]")
        sys.exit(1)

    if pr.status == PRStatus.MERGED:
        console.print(f"[yellow]Warning: PR '{pr_id}' is already merged[/yellow]")
        return

    if pr.status == PRStatus.CLOSED:
        console.print(f"[yellow]PR '{pr_id}' is already closed[/yellow]")
        return

    if click.confirm(f"Are you sure you want to close PR #{pr_id} '{pr.title}'?"):
        db.update_pr_status(pr_id, PRStatus.CLOSED)
        console.print(f"[green]PR #{pr_id} closed[/green]")


@main.command()
@click.argument("pr_id")
@click.option("--force", "-f", is_flag=True, help="Force delete without confirmation")
def delete(pr_id: str, force: bool) -> None:
    """Delete a PR and all associated data."""
    pr = db.get_pr_by_uuid(pr_id)
    if not pr:
        console.print(f"[red]Error: PR '{pr_id}' not found[/red]")
        sys.exit(1)

    if not force:
        console.print(
            f"[bold red]Warning: This will permanently delete PR #{pr_id} and all its comments/reviews.[/bold red]"
        )
        if not click.confirm(f"Are you sure you want to delete PR #{pr_id} '{pr.title}'?"):
            console.print("[dim]Aborted[/dim]")
            return

    if db.delete_pr(pr_id):
        console.print(f"[green]PR #{pr_id} deleted[/green]")
    else:
        console.print(f"[red]Failed to delete PR #{pr_id}[/red]")


@main.command()
@click.argument("pr_id")
@click.option(
    "--repo", "-r", default=None, help="Path to git repository (uses PR's repo by default)"
)
def update(pr_id: str, repo: str | None) -> None:
    """Update PR diff after making changes."""
    pr = db.get_pr_by_uuid(pr_id)
    if not pr:
        console.print(f"[red]Error: PR '{pr_id}' not found[/red]")
        sys.exit(1)

    repo_path = repo or pr.repo_path
    git = GitOps(repo_path)

    # Get new diff
    diff = git.get_diff(pr.base_ref, pr.head_ref)
    head_commit = git.get_commit_sha(pr.head_ref)

    # Update in database
    new_revision = db.update_pr_diff(pr_id, diff, head_commit)

    # Reset status to pending for re-review
    db.update_pr_status(pr_id, PRStatus.PENDING)

    console.print(
        Panel(
            f"[green]PR #{pr_id} updated to revision {new_revision}[/green]\n\n"
            f"Status reset to [yellow]pending[/yellow] for re-review",
            title="PR Updated",
        )
    )


@main.command()
@click.argument("pr_id")
@click.option("--push/--no-push", default=True, help="Push to remote after merge")
@click.option(
    "--delete-branch/--keep-branch", default=False, help="Delete source branch after merge"
)
@click.option("--repo", "-r", default=None, help="Path to git repository")
def merge(pr_id: str, push: bool, delete_branch: bool, repo: str | None) -> None:
    """Merge an approved PR."""
    pr = db.get_pr_by_uuid(pr_id)
    if not pr:
        console.print(f"[red]Error: PR '{pr_id}' not found[/red]")
        sys.exit(1)

    if pr.status != PRStatus.APPROVED:
        console.print(f"[red]Error: PR is not approved (current status: {pr.status.value})[/red]")
        console.print("[dim]Only approved PRs can be merged[/dim]")
        sys.exit(1)

    repo_path = repo or pr.repo_path
    git = GitOps(repo_path)

    # Check for uncommitted changes
    if git.has_uncommitted_changes():
        console.print("[red]Error: Repository has uncommitted changes[/red]")
        console.print("[dim]Please commit or stash changes before merging[/dim]")
        sys.exit(1)

    # Perform merge
    merge_result = git.merge(pr.head_ref, pr.base_ref)

    if not merge_result["success"]:
        console.print(f"[red]Merge failed: {merge_result['message']}[/red]")
        sys.exit(1)

    console.print(f"[green]{merge_result['message']}[/green]")

    # Push if requested
    if push:
        push_result = git.push()
        if push_result["success"]:
            console.print(f"[green]{push_result['message']}[/green]")
        else:
            console.print(f"[yellow]Warning: Push failed: {push_result['message']}[/yellow]")

    # Delete source branch if requested
    if delete_branch:
        delete_result = git.delete_branch(pr.head_ref)
        if delete_result["success"]:
            console.print(f"[dim]{delete_result['message']}[/dim]")

    # Update PR status
    db.update_pr_status(pr_id, PRStatus.MERGED)

    console.print(
        Panel(
            f"[green]PR #{pr_id} merged successfully![/green]",
            title="Merge Complete",
        )
    )


@main.command()
@click.argument("pr_id")
def show(pr_id: str) -> None:
    """Show detailed information about a PR."""
    pr = db.get_pr_by_uuid(pr_id)
    if not pr:
        console.print(f"[red]Error: PR '{pr_id}' not found[/red]")
        sys.exit(1)

    # GitHub-style status colors
    status_colors = {
        PRStatus.PENDING: "#d29922",  # GitHub yellow
        PRStatus.APPROVED: "#3fb950",  # GitHub green
        PRStatus.CHANGES_REQUESTED: "#f85149",  # GitHub red
        PRStatus.MERGED: "#a371f7",  # GitHub purple
        PRStatus.CLOSED: "#8b949e",  # GitHub gray
    }
    color = status_colors.get(pr.status, "white")

    info = f"""[bold]Title:[/bold] {pr.title}
[bold]Status:[/bold] [{color}]{pr.status.value}[/{color}]
[bold]Repository:[/bold] {pr.repo_path}
[bold]Branch:[/bold] {pr.head_ref} -> {pr.base_ref}
[bold]Created:[/bold] {pr.created_at}
[bold]Updated:[/bold] {pr.updated_at}"""

    if pr.description:
        info += f"\n\n[bold]Description:[/bold]\n{pr.description}"

    console.print(Panel(info, title=f"PR #{pr.uuid}"))

    # Show comments count
    comments_list = db.get_comments(pr_id)
    unresolved_count = len([c for c in comments_list if not c.resolved])
    if comments_list:
        console.print(
            f"\n[bold]Comments:[/bold] {len(comments_list)} ({unresolved_count} unresolved)"
        )

    # Show diff preview
    diff = db.get_latest_diff(pr_id)
    if diff:
        console.print("\n[bold]Diff preview:[/bold]")
        lines = diff.split("\n")[:20]
        preview = "\n".join(lines)
        if len(diff.split("\n")) > 20:
            preview += "\n... (truncated)"
        console.print(Syntax(preview, "diff", theme="monokai"))


def is_port_in_use(port: int) -> bool:
    """Check if a port is already in use."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("localhost", port)) == 0


def find_web_dir() -> Path | None:
    """Find the claude-reviewer web app directory for development.

    IMPORTANT: Does NOT check current working directory to avoid
    accidentally using a project's own docker-compose.yml.

    This is only used when --dev flag is passed or CLAUDE_REVIEWER_WEB_DIR is set.
    """
    # Check environment variable first
    if env_dir := os.environ.get("CLAUDE_REVIEWER_WEB_DIR"):
        path = Path(env_dir)
        if (path / "docker-compose.yml").exists():
            return path

    # Check relative to source file (for development installs)
    cli_dir = Path(__file__).parent.parent
    web_dir = cli_dir.parent
    if (web_dir / "docker-compose.yml").exists():
        # Verify it's actually the claude-reviewer compose file
        compose_content = (web_dir / "docker-compose.yml").read_text()
        if "claude-reviewer" in compose_content or "claude_reviewer" in compose_content:
            return web_dir

    # Check common install locations
    home = Path.home()
    common_paths = [
        home / ".claude-reviewer" / "web",
        home / "claude-reviewer",
        Path("/opt/claude-reviewer"),
    ]
    for path in common_paths:
        if (path / "docker-compose.yml").exists():
            return path

    return None


# Docker image to use
DOCKER_IMAGE = "bowles/claude-reviewer:latest"
# Container name for running the web UI
CONTAINER_NAME = "claude-reviewer-web"
# Unique project name to avoid conflicts with other docker-compose projects (for dev mode)
COMPOSE_PROJECT_NAME = "claude-reviewer"


def verify_docker_container(container_name: str) -> bool:
    """Check if a container is running."""
    result = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", container_name],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def is_docker_running() -> bool:
    """Check if Docker daemon is running."""
    result = subprocess.run(["docker", "info"], capture_output=True, text=True)
    return result.returncode == 0


def is_web_ui_running(port: int = 41729) -> bool:
    """Check if the web UI is running (either via Docker or locally)."""
    # Check if our Docker container is running
    if verify_docker_container(CONTAINER_NAME):
        return True
    # Check if port is in use (could be local dev server)
    return bool(is_port_in_use(port))


def get_local_server_pid_file(port: int) -> Path:
    """Path to the PID file tracking a locally-running (non-Docker) web server."""
    return Path.home() / ".claude-reviewer" / f"local-server-{port}.pid"


def run_local_server(port: int, web_dir: Path) -> None:
    """Run the web server locally using npm."""
    console.print(f"[bold]Starting local web server on port {port}...[/bold]")
    console.print(f"[dim]Working directory: {web_dir}[/dim]")

    # Check for node_modules
    if not (web_dir / "node_modules").exists():
        console.print("[yellow]Installing dependencies...[/yellow]")
        subprocess.run(["npm", "ci"], cwd=web_dir, check=True)

    # Build if needed (simple check for .next)
    if not (web_dir / ".next").exists():
        console.print("[yellow]Building application...[/yellow]")
        subprocess.run(["npm", "run", "build"], cwd=web_dir, check=True)

    env = os.environ.copy()
    env["PORT"] = str(port)

    console.print(f"[green]Starting server at http://localhost:{port}[/green]")

    pid_file = get_local_server_pid_file(port)
    pid_file.parent.mkdir(parents=True, exist_ok=True)

    # New session so the whole npm -> next-server tree shares one process
    # group, letting `stop` kill it as a unit even if this CLI process exits.
    process = subprocess.Popen(
        ["npm", "run", "start"], cwd=web_dir, env=env, start_new_session=True
    )
    pid_file.write_text(str(process.pid))
    try:
        process.wait()
    except KeyboardInterrupt:
        console.print("\n[yellow]Server stopped[/yellow]")
        process.terminate()
        process.wait()
    finally:
        pid_file.unlink(missing_ok=True)


def stop_local_server(port: int) -> bool:
    """Stop a locally-running (--local) web server, if any.

    Falls back to whatever process is listening on the port if the PID
    file is missing or stale, e.g. because the CLI process that started
    it was killed or exited without cleaning up.
    """
    pid_file = get_local_server_pid_file(port)
    pid: int | None = None

    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
        except ValueError:
            pid = None

    if pid is None and is_port_in_use(port):
        result = subprocess.run(["lsof", "-ti", f"tcp:{port}"], capture_output=True, text=True)
        listening_pids = [int(p) for p in result.stdout.split() if p.strip()]
        pid = listening_pids[0] if listening_pids else None

    pid_file.unlink(missing_ok=True)

    if pid is None:
        return False

    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
        return True
    except (ProcessLookupError, PermissionError):
        return False


@main.command()
@click.option("--port", "-p", default=41729, help="Port for web UI (default: 41729)")
@click.option("--detach/--no-detach", "-d", default=True, help="Run in background (Docker only)")
@click.option("--dev", is_flag=True, help="Use local docker-compose for development")
@click.option("--pull/--no-pull", default=True, help="Pull latest image before starting")
@click.option("--local", is_flag=True, help="Run locally using npm (requires source)")
@click.option(
    "--check",
    is_flag=True,
    help="Only report whether the web UI is reachable; don't start or stop anything",
)
def serve(port: int, detach: bool, dev: bool, pull: bool, local: bool, check: bool) -> None:
    """Start the web UI server.

    By default, pulls and runs the Docker image from Docker Hub.
    Use --local to run with npm start (requires source code).
    Use --dev for local development with docker-compose.
    Use --check to see whether it's already reachable, without starting anything —
    exits 0 if it's up, 1 if it's not.
    """
    if check:
        if is_web_ui_running(port):
            console.print(f"[green]Web UI is running on port {port}[/green]")
            sys.exit(0)
        console.print(f"[yellow]Web UI is not running on port {port}[/yellow]")
        sys.exit(1)

    # Check if port is already in use
    if is_port_in_use(port):
        console.print(f"[red]Error: Port {port} is already in use[/red]")
        console.print("[dim]Try a different port: claude-reviewer serve --port 3457[/dim]")
        sys.exit(1)

    # Handle local mode first
    if local:
        web_dir = find_web_dir()
        if not web_dir:
            console.print("[red]Error: Local mode requires claude-reviewer source[/red]")
            # Fallback check
            cwd = Path.cwd()
            if (cwd / "package.json").exists() and (cwd / "next.config.ts").exists():
                web_dir = cwd
            else:
                sys.exit(1)

        run_local_server(port, web_dir)
        return

    # Check if docker is available
    docker_check = subprocess.run(["docker", "info"], capture_output=True, text=True)
    if docker_check.returncode != 0:
        console.print("[yellow]Warning: Docker is not running or not installed[/yellow]")

        # Try finding web dir for fallback
        web_dir = find_web_dir()
        if web_dir and click.confirm("Do you want to run locally with npm instead?"):
            run_local_server(port, web_dir)
            return

        console.print(
            "[red]Error: Docker required. Install Docker or run from source with --local[/red]"
        )
        sys.exit(1)

    # Development mode: use docker-compose
    if dev or os.environ.get("CLAUDE_REVIEWER_WEB_DIR"):
        web_dir = find_web_dir()
        if not web_dir:
            console.print("[red]Error: Development mode requires claude-reviewer source[/red]")
            console.print("")
            console.print("[bold]Clone the repository:[/bold]")
            console.print("  [cyan]git clone https://github.com/bowlesb/claude-reviewer[/cyan]")
            console.print("  [cyan]cd claude-reviewer[/cyan]")
            console.print("  [cyan]pip install -e claude-reviewer-cli[/cyan]")
            sys.exit(1)

        compose_file = web_dir / "docker-compose.yml"
        console.print(f"[bold]Starting Claude Reviewer (dev mode) on port {port}...[/bold]")
        console.print(f"[dim]Using: {compose_file}[/dim]")

        cmd = ["docker", "compose", "-f", str(compose_file), "-p", COMPOSE_PROJECT_NAME]
        up_cmd = cmd + ["up", "--build"] if dev else cmd + ["up"]
        if detach:
            up_cmd.append("-d")

        env = os.environ.copy()
        env["PORT"] = str(port)

        result = subprocess.run(up_cmd, cwd=web_dir, env=env)

        if result.returncode == 0 and detach:
            console.print(
                Panel(
                    f"[green]Web UI started (dev mode)![/green]\n\n"
                    f"[bold]URL:[/bold] http://localhost:{port}\n\n"
                    f"[dim]Stop with: claude-reviewer stop[/dim]",
                    title="Claude Reviewer",
                )
            )
        elif result.returncode != 0:
            console.print("[red]Failed to start web UI[/red]")
            sys.exit(1)
        return

    # Production mode: pull and run from Docker Hub
    console.print(f"[bold]Starting Claude Reviewer web UI on port {port}...[/bold]")

    # Stop existing container if running
    subprocess.run(
        ["docker", "rm", "-f", CONTAINER_NAME],
        capture_output=True,
    )

    # Pull latest image
    if pull:
        console.print(f"[dim]Pulling {DOCKER_IMAGE}...[/dim]")
        pull_result = subprocess.run(
            ["docker", "pull", DOCKER_IMAGE],
            capture_output=True,
            text=True,
        )
        if pull_result.returncode != 0:
            console.print("[yellow]Warning: Could not pull latest image[/yellow]")
            console.print(f"[dim]{pull_result.stderr}[/dim]")

    # Ensure data directory exists
    data_dir = Path.home() / ".claude-reviewer"
    data_dir.mkdir(exist_ok=True)

    # Run the container as the host user to ensure proper file permissions
    # This fixes "attempt to write a readonly database" errors
    run_cmd = [
        "docker",
        "run",
        "--name",
        CONTAINER_NAME,
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "-p",
        f"{port}:3000",
        "-v",
        f"{data_dir}:/data",
        "-v",
        f"{Path.home()}:/host-home:ro",
        "-e",
        "DATABASE_PATH=/data/data.db",
        "-e",
        "DATABASE_DIR=/data",
    ]

    if detach:
        run_cmd.append("-d")

    run_cmd.append(DOCKER_IMAGE)

    run_result = subprocess.run(run_cmd, capture_output=True, text=True)

    if run_result.returncode == 0:
        # Verify it's actually running
        time.sleep(1)  # Give it a moment to potentially crash
        if verify_docker_container(CONTAINER_NAME):
            if detach:
                console.print(
                    Panel(
                        f"[green]Web UI started successfully![/green]\n\n"
                        f"[bold]URL:[/bold] http://localhost:{port}\n\n"
                        f"[dim]Stop with: claude-reviewer stop[/dim]",
                        title="Claude Reviewer",
                    )
                )
        else:
            # It crashed immediately
            console.print("[red]Error: Container started but exited immediately[/red]")
            logs = subprocess.run(
                ["docker", "logs", CONTAINER_NAME], capture_output=True, text=True
            )
            console.print(f"[dim]Logs:\n{logs.stderr}\n{logs.stdout}[/dim]")
            sys.exit(1)
    else:
        console.print("[red]Failed to start web UI[/red]")
        console.print(f"[dim]{run_result.stderr}[/dim]")
        sys.exit(1)


@main.command()
@click.option(
    "--port", "-p", default=41729, help="Port the local web server is running on (default: 41729)"
)
def stop(port: int) -> None:
    """Stop the web UI server.

    Stops claude-reviewer Docker containers as well as a locally-running
    (--local) server on the given port.
    """
    console.print("[bold]Stopping Claude Reviewer web UI...[/bold]")

    stopped = False

    # Try to stop the standalone container first (production mode)
    result = subprocess.run(
        ["docker", "rm", "-f", CONTAINER_NAME],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        stopped = True

    # Also try to stop docker-compose containers (dev mode)
    compose_result = subprocess.run(
        ["docker", "compose", "-p", COMPOSE_PROJECT_NAME, "down"],
        capture_output=True,
        text=True,
    )
    if compose_result.returncode == 0 and "Removed" in compose_result.stderr:
        stopped = True

    # Also stop a locally-running (--local) server, if any
    if stop_local_server(port):
        stopped = True

    if stopped:
        console.print("[green]Stopped[/green]")
    else:
        console.print("[yellow]No claude-reviewer web UI was running[/yellow]")


@main.command("open")
@click.argument("pr_id", required=False)
@click.option("--port", "-p", default=41729, help="Port for web UI (default: 41729)")
def open_ui(pr_id: str | None, port: int) -> None:
    """Open the web UI in your browser.

    Pass a PR id to jump straight to that PR's review page instead of the dashboard.
    Never starts the web UI itself — if it's not reachable, this reports that and
    tells you to run `serve` first.
    """
    if pr_id and not db.get_pr_by_uuid(pr_id):
        console.print(f"[red]Error: PR '{pr_id}' not found[/red]")
        sys.exit(1)

    if not is_web_ui_running(port):
        console.print(f"[yellow]Web UI is not running on port {port}[/yellow]")
        console.print("[dim]Start it with: claude-reviewer serve[/dim]")
        sys.exit(1)

    url = get_review_url(pr_id, port)
    console.print(f"[green]Opening {url}[/green]")
    webbrowser.open(url)


@main.command()
@click.argument("pr_id")
@click.argument("comment_uuid")
@click.argument("message")
@click.option("--author", "-a", default="claude", help="Author name (default: claude)")
def reply(pr_id: str, comment_uuid: str, message: str, author: str) -> None:
    """Reply to a comment explaining what was done to address it."""
    pr = db.get_pr_by_uuid(pr_id)
    if not pr:
        console.print(f"[red]Error: PR '{pr_id}' not found[/red]")
        sys.exit(1)

    comment = db.get_comment_by_uuid(comment_uuid)
    if not comment:
        console.print(f"[red]Error: Comment '{comment_uuid}' not found[/red]")
        sys.exit(1)

    try:
        reply_uuid = db.add_reply(comment_uuid, message, author)
        console.print(f"[green]Reply added to comment {comment_uuid}[/green]")
        console.print(f"[dim]Reply ID: {reply_uuid}[/dim]")
    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@main.command()
@click.argument("pr_id")
@click.option(
    "--until",
    "-u",
    type=click.Choice(["approved", "changes_requested", "feedback_given", "pending", "any_change"]),
    default="feedback_given",
    help="Wait until this status (default: feedback_given = approved or changes_requested)",
)
@click.option("--interval", "-i", default=2, help="Polling interval in seconds (default: 2)")
@click.option("--timeout", "-t", default=0, help="Timeout in seconds (0 = no timeout)")
def watch(pr_id: str, until: str, interval: int, timeout: int) -> None:
    """Watch a PR and wait for status changes.

    Useful for waiting after creating a PR to see reviewer feedback.
    Uses a spinner animation while waiting.

    The default --until feedback_given waits for either approval or changes_requested.
    """
    from rich.live import Live
    from rich.spinner import Spinner
    from rich.text import Text

    pr = db.get_pr_by_uuid(pr_id)
    if not pr:
        console.print(f"[red]Error: PR '{pr_id}' not found[/red]")
        sys.exit(1)

    initial_status = pr.status.value
    initial_updated = pr.updated_at

    console.print(f"[bold]Watching PR #{pr_id}[/bold]")
    console.print(f"Current status: [yellow]{initial_status}[/yellow]")
    console.print(f"Waiting for: [cyan]{until}[/cyan]")
    console.print(f"[dim]Polling every {interval}s... (Ctrl+C to stop)[/dim]\n")

    start_time = time.time()

    def make_spinner_text(elapsed: int) -> Text:
        text = Text()
        text.append("⏳ Watching... ", style="cyan")
        text.append(f"{elapsed}s", style="dim")
        return text

    try:
        with Live(Spinner("dots", text=make_spinner_text(0)), refresh_per_second=10) as live:
            while True:
                time.sleep(interval)

                # Check timeout
                elapsed = int(time.time() - start_time)
                if timeout > 0 and elapsed > timeout:
                    live.stop()
                    console.print("[yellow]Timeout reached[/yellow]")
                    sys.exit(1)

                # Update spinner
                live.update(Spinner("dots", text=make_spinner_text(elapsed)))

                # Refresh PR data
                pr = db.get_pr_by_uuid(pr_id)
                if not pr:
                    live.stop()
                    console.print("[red]PR no longer exists[/red]")
                    sys.exit(1)

                current_status = pr.status.value

                # Check for any change
                if until == "any_change":
                    if current_status != initial_status or pr.updated_at != initial_updated:
                        live.stop()
                        console.print("[green]✓ Change detected![/green]")
                        console.print(f"Status: [bold]{current_status}[/bold]")

                        # Show new comments if any
                        comments_list = db.get_comments(pr_id, unresolved_only=True)
                        if comments_list:
                            console.print(
                                f"\n[bold]Unresolved comments ({len(comments_list)}):[/bold]\n"
                            )
                            for c in comments_list:
                                print_comment(c)
                                console.print()
                        sys.exit(0)
                elif until == "feedback_given":
                    # Wait for either approved or changes_requested
                    if current_status in ("approved", "changes_requested"):
                        live.stop()
                        if current_status == "approved":
                            console.print("[#3fb950]✓ PR approved![/#3fb950]")
                        else:
                            console.print("[#f85149]✓ Changes requested[/#f85149]")
                            # Show the comments
                            comments_list = db.get_comments(pr_id, unresolved_only=True)
                            if comments_list:
                                console.print("\n[bold]Review comments:[/bold]\n")
                                for c in comments_list:
                                    print_comment(c)
                                    console.print()
                        sys.exit(0)
                else:
                    # Check for specific status
                    if current_status == until:
                        live.stop()
                        # GitHub-style status colors
                        status_colors = {
                            "approved": "#3fb950",
                            "changes_requested": "#f85149",
                            "pending": "#d29922",
                        }
                        color = status_colors.get(until, "white")
                        console.print(f"[{color}]✓ PR is now {until}![/{color}]")

                        if until == "changes_requested":
                            # Show the comments
                            comments_list = db.get_comments(pr_id, unresolved_only=True)
                            if comments_list:
                                console.print("\n[bold]Review comments:[/bold]\n")
                                for c in comments_list:
                                    print_comment(c)
                                    console.print()
                        sys.exit(0)

    except KeyboardInterrupt:
        console.print("\n[yellow]Stopped watching[/yellow]")
        sys.exit(0)


def get_file_context(
    repo_path: str, file_path: str, line_number: int, context_lines: int = 10
) -> str:
    """Get file content around a specific line."""
    full_path = Path(repo_path) / file_path
    if not full_path.exists():
        return f"[File {file_path} not found]"

    try:
        with open(full_path, encoding="utf-8") as f:
            lines = f.readlines()

        start = max(0, line_number - context_lines - 1)
        end = min(len(lines), line_number + context_lines)

        context_lines_list = []
        for i in range(start, end):
            prefix = ">>> " if i == line_number - 1 else "    "
            context_lines_list.append(f"{prefix}{i + 1:4d} | {lines[i].rstrip()}")

        return "\n".join(context_lines_list)
    except Exception as e:
        return f"[Error reading file: {e}]"


def get_diff_line_context(
    diff_content: str, file_path: str, line_number: int, line_type: str, context_lines: int = 10
) -> str | None:
    """Get diff content around a specific old-side or new-side line.

    Unlike get_file_context, this reads the line from the PR's stored diff rather
    than the working tree, since an old-side line number is only meaningful
    relative to the diff it was anchored against (the line may no longer exist,
    or may exist at a different line number, in the current working tree).

    Returns None if the file or line can't be located in the diff.
    """
    for file_section in re.split(r"^diff --git ", diff_content, flags=re.MULTILINE)[1:]:
        section_lines = file_section.splitlines()
        header_match = re.match(r"a/(.*?) b/(.*)", section_lines[0])
        if not header_match or header_match.group(2) != file_path:
            continue

        old_ln = new_ln = 0
        rows: list[tuple[int | None, int | None, str]] = []
        for line in section_lines[1:]:
            hunk_match = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)", line)
            if hunk_match:
                old_ln = int(hunk_match.group(1)) - 1
                new_ln = int(hunk_match.group(2)) - 1
                continue
            if line.startswith(("---", "+++", "index ", "new file mode", "deleted file mode")):
                continue
            if line.startswith("+"):
                new_ln += 1
                rows.append((None, new_ln, line))
            elif line.startswith("-"):
                old_ln += 1
                rows.append((old_ln, None, line))
            else:
                old_ln += 1
                new_ln += 1
                rows.append((old_ln, new_ln, line))

        target_idx = None
        for i, (o, n, _line) in enumerate(rows):
            if line_type == "old" and o == line_number and n is None:
                target_idx = i
                break
            if line_type != "old" and n == line_number:
                target_idx = i
                break

        if target_idx is None:
            return None

        start = max(0, target_idx - context_lines)
        end = min(len(rows), target_idx + context_lines + 1)
        context_lines_list = []
        for i in range(start, end):
            o, n, line = rows[i]
            prefix = ">>> " if i == target_idx else "    "
            old_col = f"{o:4d}" if o is not None else "    "
            new_col = f"{n:4d}" if n is not None else "    "
            context_lines_list.append(f"{prefix}{old_col} {new_col} | {line}")

        return "\n".join(context_lines_list)

    return None


def call_claude(prompt: str, allow_edits: bool = False, cwd: str | None = None) -> str:
    """Call Claude CLI with a prompt and return the response.

    Args:
        prompt: The prompt to send to Claude
        allow_edits: If True, allows Claude to edit files without permission prompts
        cwd: Working directory to run Claude in (important for file edits)
    """
    try:
        cmd = ["claude", "-p"]
        if allow_edits:
            cmd.insert(1, "--dangerously-skip-permissions")

        result = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=300 if allow_edits else 120,
            cwd=cwd,
        )
        if result.returncode != 0:
            return f"[Error calling Claude: {result.stderr}]"
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        return "[Error: Claude response timed out]"
    except FileNotFoundError:
        return "[Error: Claude CLI not found. Make sure 'claude' is installed and in PATH]"
    except Exception as e:
        return f"[Error calling Claude: {e}]"


@main.command("watch-all")
@click.option("--repo", "-r", default=".", help="Path to git repository")
@click.option("--interval", "-i", default=3, help="Polling interval in seconds (default: 3)")
@click.option("--once", is_flag=True, help="Run once and exit (don't poll)")
@click.option(
    "--fix",
    is_flag=True,
    help="Allow Claude to edit files to fix issues (uses --dangerously-skip-permissions)",
)
def watch_all(repo: str, interval: int, once: bool, fix: bool) -> None:
    """Watch for ALL unanswered comments and conversations, respond with Claude.

    This unified watch command monitors:
    - PR inline comments (on any PR in the repo)
    - Browse/Explore conversations (repo-level discussions)

    Enables an async workflow where you can leave comments anywhere in the UI
    and Claude will respond to them.

    Use --fix to allow Claude to actually edit files to address feedback.
    """
    from rich.live import Live
    from rich.spinner import Spinner
    from rich.text import Text

    # Normalize path
    repo_path = str(Path(repo).resolve())
    repo_path_slash = repo_path + "/" if not repo_path.endswith("/") else repo_path

    console.print(f"[bold]Watching ALL conversations in {repo_path}[/bold]")
    console.print("[dim]Monitoring: PR comments + Browse conversations[/dim]")
    if fix:
        console.print("[yellow]Fix mode enabled: Claude can edit files[/yellow]")
    if not once:
        console.print(f"[dim]Polling every {interval}s... (Ctrl+C to stop)[/dim]\n")

    def make_spinner_text(pr_count: int, conv_count: int, elapsed: int) -> Text:
        text = Text()
        text.append("👀 Watching... ", style="cyan")
        text.append(f"(PRs: {pr_count}, Convos: {conv_count}) ", style="green")
        text.append(f"{elapsed}s", style="dim")
        return text

    pr_responded = 0
    conv_responded = 0
    start_time = time.time()

    def get_unanswered_browse() -> list[tuple[RepoConversation, list[RepoConversationMessage]]]:
        """Get unanswered browse conversations, trying both path formats."""
        unanswered = db.get_unanswered_conversations(repo_path)
        if not unanswered:
            unanswered = db.get_unanswered_conversations(repo_path_slash)
        return unanswered

    def get_unanswered_prs() -> list[tuple[PullRequest, Comment, list[CommentReply]]]:
        """Get unanswered PR comments."""
        return db.get_unanswered_pr_comments(repo_path)

    try:
        if once:
            # Run once without spinner
            browse_unanswered = get_unanswered_browse()
            pr_unanswered = get_unanswered_prs()

            total = len(browse_unanswered) + len(pr_unanswered)
            if total == 0:
                console.print("[dim]No unanswered comments or conversations found[/dim]")
                return

            console.print(
                f"[bold]Found {len(pr_unanswered)} PR comment(s), {len(browse_unanswered)} conversation(s)[/bold]\n"
            )

            # Handle PR comments
            for pr, comment, replies in pr_unanswered:
                respond_to_pr_comment(repo_path, pr, comment, replies, allow_edits=fix)
                pr_responded += 1

            # Handle browse conversations
            for conv, messages in browse_unanswered:
                respond_to_conversation(repo_path, conv, messages, allow_edits=fix)
                conv_responded += 1

            console.print(
                f"\n[green]✓ Responded to {pr_responded} PR comment(s), {conv_responded} conversation(s)[/green]"
            )
        else:
            with Live(
                Spinner("dots", text=make_spinner_text(0, 0, 0)), refresh_per_second=4
            ) as live:
                while True:
                    elapsed = int(time.time() - start_time)
                    live.update(
                        Spinner(
                            "dots", text=make_spinner_text(pr_responded, conv_responded, elapsed)
                        )
                    )

                    # Check PR comments
                    pr_unanswered = get_unanswered_prs()
                    for pr, comment, replies in pr_unanswered:
                        live.stop()
                        respond_to_pr_comment(repo_path, pr, comment, replies, allow_edits=fix)
                        pr_responded += 1
                        live.start()

                    # Check browse conversations
                    browse_unanswered = get_unanswered_browse()
                    for conv, messages in browse_unanswered:
                        live.stop()
                        respond_to_conversation(repo_path, conv, messages, allow_edits=fix)
                        conv_responded += 1
                        live.start()

                    time.sleep(interval)

    except KeyboardInterrupt:
        console.print(
            f"\n[yellow]Stopped. Responded to {pr_responded} PR comment(s), {conv_responded} conversation(s)[/yellow]"
        )
        sys.exit(0)


# Keep old command as alias for backwards compatibility
@main.command("watch-conversations")
@click.option("--repo", "-r", default=".", help="Path to git repository")
@click.option("--interval", "-i", default=5, help="Polling interval in seconds (default: 5)")
@click.option("--once", is_flag=True, help="Run once and exit (don't poll)")
@click.option("--fix", is_flag=True, help="Allow Claude to edit files to fix issues")
@click.pass_context
def watch_conversations(
    ctx: click.Context, repo: str, interval: int, once: bool, fix: bool
) -> None:
    """[Deprecated] Use 'watch-all' instead. Watches browse conversations only."""
    console.print(
        "[yellow]Note: 'watch-conversations' is deprecated. Use 'watch-all' for unified watching.[/yellow]\n"
    )
    ctx.invoke(watch_all, repo=repo, interval=interval, once=once, fix=fix)


def respond_to_conversation(
    repo_path: str,
    conv: RepoConversation,
    messages: list[RepoConversationMessage],
    allow_edits: bool = False,
) -> None:
    """Generate and post Claude's response to a conversation."""
    console.print(
        f"\n[cyan]Responding to conversation in {conv.file_path}:{conv.line_number}[/cyan]"
    )

    # Get file context
    line_number = conv.current_line_number or conv.line_number
    file_context = get_file_context(repo_path, conv.file_path, line_number)

    # Build conversation history
    conv_history = "\n".join([f"[{msg.author}]: {msg.content}" for msg in messages])

    # Build prompt - different based on whether edits are allowed
    if allow_edits:
        prompt = f"""You are Claude, an AI assistant helping with code review and discussion.

A user has started a conversation about a specific line of code. You have permission to edit files to address their feedback.

REPOSITORY: {repo_path}
FILE: {conv.file_path}
LINE: {line_number}

CODE CONTEXT (the >>> marks the line being discussed):
{file_context}

CONVERSATION SO FAR:
{conv_history}

Please respond to the user's latest message. If they're requesting a change or fix:
1. Make the necessary edits to the file
2. Briefly explain what you changed

If they're just asking a question, answer it. Be concise."""
    else:
        prompt = f"""You are Claude, an AI assistant helping with code review and discussion.

A user has started a conversation about a specific line of code. Please provide a helpful response.

FILE: {conv.file_path}
LINE: {line_number}

CODE CONTEXT (the >>> marks the line being discussed):
{file_context}

CONVERSATION SO FAR:
{conv_history}

Please respond to the user's latest message. Be concise but helpful. If they're asking about the code, explain what it does. If they're suggesting a change, discuss the pros and cons. If they have a question, answer it.

Your response (just the message content, no prefixes):"""

    console.print("[dim]Generating response...[/dim]")
    response = call_claude(prompt, allow_edits=allow_edits, cwd=repo_path)

    if response.startswith("[Error"):
        console.print(f"[red]{response}[/red]")
        return

    # Post the response
    try:
        db.add_repo_conversation_message(conv.uuid, response, author="claude")
        console.print("[green]✓ Posted response[/green]")
        console.print(Panel(response, title="Claude's response", border_style="green"))
    except Exception as e:
        console.print(f"[red]Error posting response: {e}[/red]")

    # If edits were allowed, commit any changes and try to update any matching PR
    if allow_edits:
        try:
            git = GitOps(repo_path)
            if git.has_uncommitted_changes():
                # Commit the changes
                commit_msg = f"Address feedback: {conv.file_path}:{line_number}\n\nCo-Authored-By: Claude <noreply@anthropic.com>"
                commit_result = git.commit_all(commit_msg)
                if commit_result["success"]:
                    console.print(f"[green]✓ {commit_result['message']}[/green]")

                    # Try to find and update any PR on the current branch
                    current_branch = git.get_current_branch()
                    prs = db.list_prs(repo_path=repo_path)
                    matching_pr = next(
                        (
                            p
                            for p in prs
                            if p.head_ref == current_branch
                            and p.status.value not in ("merged", "closed")
                        ),
                        None,
                    )
                    if matching_pr:
                        diff = git.get_diff(matching_pr.base_ref, matching_pr.head_ref)
                        head_commit = git.get_commit_sha(matching_pr.head_ref)
                        new_revision = db.update_pr_diff(matching_pr.uuid, diff, head_commit)
                        console.print(
                            f"[green]✓ Updated PR #{matching_pr.uuid} diff (revision {new_revision})[/green]"
                        )
                else:
                    console.print("[yellow]No changes to commit[/yellow]")
        except Exception as e:
            console.print(f"[yellow]Warning: Could not commit changes: {e}[/yellow]")


def respond_to_pr_comment(
    repo_path: str,
    pr: PullRequest,
    comment: Comment,
    replies: list[CommentReply],
    allow_edits: bool = False,
) -> None:
    """Generate and post Claude's response to a PR comment."""
    console.print(
        f"\n[cyan]Responding to PR #{pr.uuid} comment in {comment.file_path}:{comment.line_number}[/cyan]"
    )

    # Get file context. Old-side comments anchor to a line number in the diff's
    # "before" tree, which may no longer exist (or exist at a different line) in
    # the current working tree, so look it up in the stored diff instead.
    if comment.line_type == "old":
        diff_content = db.get_latest_diff(pr.uuid)
        file_context = diff_content and get_diff_line_context(
            diff_content, comment.file_path, comment.line_number, comment.line_type
        )
        if not file_context:
            file_context = (
                f"[Could not locate removed line {comment.line_number} of "
                f"{comment.file_path} in the stored diff]"
            )
    else:
        file_context = get_file_context(repo_path, comment.file_path, comment.line_number)

    # Build conversation history
    conv_parts = [f"[reviewer]: {comment.content}"]
    for reply in replies:
        conv_parts.append(f"[{reply.author}]: {reply.content}")
    conv_history = "\n".join(conv_parts)

    # Build prompt - different based on whether edits are allowed
    if allow_edits:
        prompt = f"""You are Claude, an AI assistant responding to code review comments on a PR. You have permission to edit files to address feedback.

REPOSITORY: {repo_path}
PR: {pr.title}
FILE: {comment.file_path}
LINE: {comment.line_number}

CODE CONTEXT (the >>> marks the line being discussed):
{file_context}

REVIEW CONVERSATION:
{conv_history}

Please address the reviewer's feedback:
1. If the feedback requests a code change, make the edit to the file
2. Briefly explain what you changed (or why you disagree, if applicable)

Be concise."""
    else:
        prompt = f"""You are Claude, an AI assistant responding to code review comments on a PR.

PR: {pr.title}
FILE: {comment.file_path}
LINE: {comment.line_number}

CODE CONTEXT (the >>> marks the line being discussed):
{file_context}

REVIEW CONVERSATION:
{conv_history}

Please respond to the latest comment. Be concise but helpful. If it's feedback about the code:
- Acknowledge the feedback
- Explain what you'll do to address it (or why you disagree, if applicable)
- If you've already made changes, briefly describe what was done

Your response (just the message content, no prefixes):"""

    console.print("[dim]Generating response...[/dim]")
    response = call_claude(prompt, allow_edits=allow_edits, cwd=repo_path)

    if response.startswith("[Error"):
        console.print(f"[red]{response}[/red]")
        return

    # Post the reply
    try:
        db.add_reply(comment.uuid, response, author="claude")
        console.print("[green]✓ Posted reply to PR comment[/green]")
        console.print(Panel(response, title="Claude's response", border_style="green"))
    except Exception as e:
        console.print(f"[red]Error posting reply: {e}[/red]")

    # If edits were allowed, commit any changes and update the PR
    if allow_edits:
        try:
            git = GitOps(repo_path)
            if git.has_uncommitted_changes():
                # Commit the changes
                commit_msg = f"Address review feedback: {comment.file_path}:{comment.line_number}\n\nCo-Authored-By: Claude <noreply@anthropic.com>"
                commit_result = git.commit_all(commit_msg)
                if commit_result["success"]:
                    console.print(f"[green]✓ {commit_result['message']}[/green]")

                    # Update the PR diff
                    diff = git.get_diff(pr.base_ref, pr.head_ref)
                    head_commit = git.get_commit_sha(pr.head_ref)
                    new_revision = db.update_pr_diff(pr.uuid, diff, head_commit)
                    console.print(f"[green]✓ Updated PR diff (revision {new_revision})[/green]")
                else:
                    console.print("[yellow]No changes to commit[/yellow]")
        except Exception as e:
            console.print(f"[yellow]Warning: Could not commit changes: {e}[/yellow]")


# Claude Code skills bundled with this install, e.g. skills/claude-reviewer/SKILL.md
SKILLS_DIR = Path(__file__).parent / "skills"


def _available_skills() -> list[str]:
    """Names of the skills bundled with this install of the CLI."""
    if not SKILLS_DIR.is_dir():
        return []
    return sorted(p.name for p in SKILLS_DIR.iterdir() if (p / "SKILL.md").exists())


def _skill_frontmatter(skill_dir: Path) -> dict[str, str]:
    """Parse the (flat, single-line-values) YAML frontmatter of a SKILL.md file."""
    text = (skill_dir / "SKILL.md").read_text()
    if not text.startswith("---"):
        return {}
    _, frontmatter, _ = text.split("---", 2)
    result = {}
    for line in frontmatter.splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            result[key.strip()] = value.strip()
    return result


@main.group()
def skills() -> None:
    """Manage the Claude Code skills that teach Claude the claude-reviewer workflow."""


@skills.command("list")
def skills_list() -> None:
    """List the Claude Code skills bundled with this claude-reviewer install."""
    available = _available_skills()
    if not available:
        console.print("[dim]No bundled skills found[/dim]")
        return

    table = Table(title="Bundled Skills")
    table.add_column("Name", style="cyan")
    table.add_column("Description", style="white")
    for name in available:
        description = _skill_frontmatter(SKILLS_DIR / name).get("description", "")
        table.add_row(name, description)
    console.print(table)


@skills.command("install")
@click.argument("names", nargs=-1)
@click.option(
    "--scope",
    type=click.Choice(["user", "project"]),
    default="user",
    help="Install to ~/.claude/skills (user, default) or <repo>/.claude/skills (project)",
)
@click.option("--repo", "-r", default=".", help="Project root when --scope=project")
@click.option("--force", "-f", is_flag=True, help="Overwrite an already-installed skill")
def skills_install(names: tuple[str, ...], scope: str, repo: str, force: bool) -> None:
    """Install claude-reviewer's Claude Code skills so Claude knows the review workflow.

    Installs all bundled skills by default. Pass one or more names to install
    a subset, e.g. `claude-reviewer skills install claude-reviewer`.

    --scope user (default) installs to ~/.claude/skills, applying to every project.
    --scope project installs to <repo>/.claude/skills, applying to this repo only.
    """
    available = _available_skills()
    if not available:
        console.print("[red]Error: no bundled skills found in this install[/red]")
        sys.exit(1)

    targets = list(names) if names else available
    unknown = [n for n in targets if n not in available]
    if unknown:
        console.print(f"[red]Error: unknown skill(s): {', '.join(unknown)}[/red]")
        console.print(f"[dim]Available: {', '.join(available)}[/dim]")
        sys.exit(1)

    dest_root = (
        Path.home() / ".claude" / "skills"
        if scope == "user"
        else Path(repo).resolve() / ".claude" / "skills"
    )
    dest_root.mkdir(parents=True, exist_ok=True)

    installed = []
    for name in targets:
        dest = dest_root / name
        if dest.exists():
            if not force and not click.confirm(
                f"'{name}' is already installed at {dest} — overwrite?"
            ):
                console.print(f"[dim]Skipped {name}[/dim]")
                continue
            shutil.rmtree(dest)
        shutil.copytree(SKILLS_DIR / name, dest)
        console.print(f"[green]Installed {name}[/green] -> {dest}")
        installed.append(name)

    if installed:
        console.print(
            "\n[dim]Restart Claude Code (or start a new session) to pick up the new skill(s).[/dim]"
        )


if __name__ == "__main__":
    main()
