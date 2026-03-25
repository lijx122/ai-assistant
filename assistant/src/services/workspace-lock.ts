type Release = () => void;

class WorkspaceLock {
    private queues = new Map<string, Promise<void>>();
    private queueSizes = new Map<string, number>();

    async acquire(workspaceId: string): Promise<Release> {
        const prev = this.queues.get(workspaceId) || Promise.resolve();
        const pending = (this.queueSizes.get(workspaceId) || 0) + 1;
        this.queueSizes.set(workspaceId, pending);

        let releaseFn!: Release;

        const next = new Promise<void>((resolve) => {
            releaseFn = resolve;
        });

        const safePrev = prev.catch((err) => {
            console.error('[WorkspaceLock] Promise chain error:', err);
        });

        this.queues.set(workspaceId, safePrev.then(() => next));

        // Wait for previous lock to release before we return our release function
        await safePrev;

        let released = false;
        return () => {
            if (released) return;
            released = true;

            releaseFn();

            const remain = (this.queueSizes.get(workspaceId) || 1) - 1;
            if (remain <= 0) {
                this.queueSizes.delete(workspaceId);
                this.queues.delete(workspaceId);
            } else {
                this.queueSizes.set(workspaceId, remain);
            }
        };
    }

    /**
     * 获取指定工作区的当前排队位置。
     * 用于飞书回复「已排队第 N 位」提示。
     * @returns 排队长度（0 表示当前无人排队，可直接获取锁）
     */
    getQueuePosition(workspaceId: string): number {
        return this.queueSizes.get(workspaceId) || 0;
    }
}

export const workspaceLock = new WorkspaceLock();
