import { Observable, Observer, Subject, Subscriber, Subscribable, Subscription, TeardownLogic } from "rxjs";
import * as z from "zod";
import type { Sink } from "./sink";

/**
 * A data stream is a typed observable.
 */
export class DataStream<T> implements Subscribable<T> {
    readonly schema: z.input<T>;
    private readonly observable: Observable<T>;

    constructor(
        schema: z.input<T>,
        subscribe?: (this: Observable<T>, subscriber: Subscriber<T>) => TeardownLogic
    ) {
        this.schema = schema;
        this.observable = new Observable<T>(subscribe);
    }

    subscribe(observer: Partial<Observer<T>>): Subscription {
        return this.observable.subscribe(observer);
    }

}
