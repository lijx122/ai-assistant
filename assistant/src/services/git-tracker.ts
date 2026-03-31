/**
 * GitTracker 服务 - 工作区 Git 版本控制
 */

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

export interface GitCommit {
    hash: string
    message: string
    date: string
    filesChanged: number
}

export class GitTracker {
    constructor(private workspaceDir: string) {}

    /**
     * 执行 git 命令，确保在正确的工作区目录下执行
     * 使用 GIT_DIR 和 GIT_WORK_TREE 强制指定仓库位置
     */
    private execGit(cmd: string): string {
        const gitDir = join(this.workspaceDir, '.git')
        return execSync(cmd, {
            cwd: this.workspaceDir,
            env: {
                ...process.env,
                GIT_DIR: gitDir,
                GIT_WORK_TREE: this.workspaceDir,
            },
            stdio: 'pipe',
        }).toString()
    }

    /**
     * 确保仓库已初始化
     */
    ensureRepo(): boolean {
        const gitDir = join(this.workspaceDir, '.git')
        if (existsSync(gitDir)) return true
        try {
            execSync('git init -b main', {
                cwd: this.workspaceDir,
                stdio: 'pipe',
                env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: this.workspaceDir }
            })
            execSync('git config user.email "assistant@local"',
                { cwd: this.workspaceDir, stdio: 'pipe' })
            execSync('git config user.name "AI Assistant"',
                { cwd: this.workspaceDir, stdio: 'pipe' })
            execSync('git commit --allow-empty -m "init"',
                { cwd: this.workspaceDir, stdio: 'pipe' })
            return true
        } catch {
            return false
        }
    }

    /**
     * 创建 commit（如果有未提交改动）
     * @param description 提交描述
     * @returns commit hash 或 null（无改动）
     */
    commit(description: string): string | null {
        if (!this.ensureRepo()) return null
        try {
            const status = this.execGit('git status --porcelain').trim()
            if (!status) return null

            this.execGit('git add -A')
            const msg = `[AI] ${description}`
                .replace(/"/g, "'").slice(0, 100)
            this.execGit(`git commit -m "${msg}"`)
            return this.execGit('git rev-parse --short HEAD').trim()
        } catch {
            return null
        }
    }

    /**
     * 获取最近 N 条 commit 记录
     */
    getLog(limit = 20): GitCommit[] {
        try {
            const out = this.execGit(
                `git log --oneline --format="%h|||%s|||%ci" -${limit}`
            ).trim()
            if (!out) return []

            return out.split('\n')
                .filter(l => l.includes('|||'))
                .map(line => {
                    const [hash, message, date] = line.split('|||')
                    // 获取该 commit 改动文件数
                    let filesChanged = 0
                    try {
                        const statOut = this.execGit(
                            `git show --stat --oneline ${hash}`
                        )
                        // 解析 "1 file changed, 2 insertions(+)" 格式
                        const match = statOut.match(/(\d+) file/)
                        filesChanged = match ? parseInt(match[1]) : 0
                    } catch {}

                    return {
                        hash: hash?.trim() || '',
                        message: message?.trim() || '',
                        date: date?.trim()?.slice(0, 16) || '',
                        filesChanged
                    }
                })
        } catch {
            return []
        }
    }

    /**
     * 回滚到指定 commit
     */
    revertTo(hash: string): { success: boolean; message: string } {
        try {
            // 保存当前状态到新 commit，方便反悔
            this.execGit('git add -A')
            try {
                this.execGit('git commit -m "[AI] snapshot before revert"')
            } catch {}

            this.execGit(`git reset --hard ${hash}`)
            return { success: true, message: `已回滚到 ${hash}` }
        } catch (e: any) {
            return { success: false, message: e.message || '回滚失败' }
        }
    }

    /**
     * 获取指定 commit 的改动统计
     */
    getDiffStat(hash: string): string {
        try {
            return this.execGit(`git show --stat --oneline ${hash}`).trim().slice(0, 500)
        } catch {
            return ''
        }
    }

    /**
     * 检查是否有未提交的改动
     */
    hasChanges(): boolean {
        try {
            const status = this.execGit('git status --porcelain').trim()
            return !!status
        } catch {
            return false
        }
    }
}

// 缓存实例，避免重复创建
const cache = new Map<string, GitTracker>()

export function getGitTracker(workspaceId: string, dir: string): GitTracker {
    if (!cache.has(workspaceId)) {
        cache.set(workspaceId, new GitTracker(dir))
    }
    return cache.get(workspaceId)!
}

export function clearGitTracker(workspaceId: string): void {
    cache.delete(workspaceId)
}
