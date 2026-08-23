import { Observable, Observer, Subject, Subscriber, Subscribable, Subscription, TeardownLogic } from "rxjs";
import * as z from "zod";
import type { Program } from "../ir/program";

/**
 * An abstract interface for a stream of data elements of type T.
 */
export class DataStream<T> implements Subscribable<T> {
    readonly schema: z.ZodType;
    private readonly observable: Observable<T>;

    constructor(
        schema: z.ZodType,
        subscribe?: (this: Observable<T>, subscriber: Subscriber<T>) => TeardownLogic
    ) {
        this.schema = schema;
        this.observable = new Observable<T>(subscribe);
    }

    subscribe(observer: Partial<Observer<T>>): Subscription {
        return this.observable.subscribe(observer);
    }

    asObservable(): Observable<T> {
        return this.observable;
    }

}

export class CSVStream<T> extends DataStream<T> {
    readonly path: string;

    constructor(path: string, schema: z.ZodType) {

    }

}




/**
 * Create a data stream from a CSV file. No reading is done until the stream is subscribed to.
 * @param path - The path to the CSV file.
 * @param schema - Optional schema to validate the data against.
 */
export function fromCSV(path: string, schema?: z.ZodType): DataStream<z.output<typeof schema>> {
    // infer the schema from the CSV file, probably through 
    // a helper method and create a new DataStream instance.
}


/**
 * Create a data stream from a WebSocket connection. No connection is established until the stream is subscribed to.
 * @param url - The URL of the WebSocket server.
 * @param schema - Optional schema to validate the data against.
 */
export function fromWebSocket(url: string, schema?: z.ZodType): DataStream<z.output<typeof schema>> {
    // create a new DataStream instance.
}