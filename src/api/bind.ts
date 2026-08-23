

import type { Program } from "../ir/program";
import type { DataStream } from "./stream";

declare module './stream' {
    export interface DataStream<T> {
        program: Program;

        bind(program: Program): DataStream<T>;
    }
}


