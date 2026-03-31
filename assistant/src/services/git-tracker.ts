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
     * 确保仓库已初始化
     */
    ensureRepo(): boolean {
        if (existsSync(join(this.workspaceDir, '.git'))) return true
        try {
            execSync('git init', { cwd: this.workspaceDir, stdio: 'pipe' })
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
            const status = execSync('git status --porcelain',
                { cwd: this.workspaceDir, stdio: 'pipe' }).toString().trim()
            if (!status) return null

            execSync('git add -A', { cwd: this.workspaceDir, stdio: 'pipe' })
            const msg = `[AI] ${description}`
                .replace(/"/g, "'").slice(0, 100)
            execSync(`git commit -m "${msg}"`,
                { cwd: this.workspaceDir, stdio: 'pipe' })
            return execSync('git rev-parse --short HEAD',
                { cwd: this.workspaceDir, stdio: 'pipe' }).toString().trim()
        } catch {
            return null
        }
    }

    /**
     * 获取最近 N 条 commit 记录
     */
    getLog(limit = 20): GitCommit[] {
        try {
            const out = execSync(
                `git log --oneline --format="%h|||%s|||%ci" -${limit}`,
                { cwd: this.workspaceDir, stdio: 'pipe' }
            ).toString().trim()
            if (!out) return []

            return out.split('\n')
                .filter(l => l.includes('|||'))
                .map(line => {
                    const [hash, message, date] = line.split('|||')
                    // 获取该 commit 改动文件数
                    let filesChanged = 0
                    try {
                        const statOut = execSync(
                            `git show --stat --oneline ${hash}`,
                            { cwd: this.workspaceDir, stdio: 'pipe' }
                        ).toString()
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
            execSync('git add -A', { cwd: this.workspaceDir, stdio: 'pipe' })
            try {
                execSync('git commit -m "[AI] snapshot before revert"',
                    { cwd: this.workspaceDir, stdio: 'pipe' })
            } catch {}

            execSync(`git reset --hard ${hash}`,
                { cwd: this.workspaceDir, stdio: 'pipe' })
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
            return execSync(`git show --stat --oneline ${hash}`,
                { cwd: this.workspaceDir, stdio: 'pipe' }
            ).toString().trim().slice(0, 500)
        } catch {
            return ''
        }
    }

    /**
     * 检查是否有未提交的改动
     */
    hasChanges(): boolean {
        try {
            const status = execSync('git status --porcelain',
                { cwd: this.workspaceDir, stdio: 'pipe' }).toString().trim()
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
