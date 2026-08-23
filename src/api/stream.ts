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
