declare module 'node-pty' {
    import { EventEmitter } from 'events';

    export interface IPtyForkOptions {
        name?: string;
        cols?: number;
        rows?: number;
        cwd?: string;
        env?: { [key: string]: string };
        uid?: number;
        gid?: number;
        encoding?: string;
    }

    export interface IPty {
        pid: number;
        cols: number;
        rows: number;
        process: string;

        write(data: string): void;
        resize(cols: number, rows: number): void;
        kill(signal?: string): void;
        pause(): void;
        resume(): void;

        onData(callback: (data: string) => void): { dispose(): void };
        onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
    }

    export function spawn(
        file: string,
        args: string[],
        options?: IPtyForkOptions
    ): IPty;
}
