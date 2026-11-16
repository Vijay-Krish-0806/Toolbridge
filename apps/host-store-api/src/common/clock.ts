/**
 * The API's source of "now". Code asks the injected Clock instead of calling new Date(),
 * so time can be frozen to match the seeded data (HOST_CLOCK_NOW) without changing logic.
 */
export abstract class Clock {
  abstract now(): Date;
}

class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

class FixedClock extends Clock {
  constructor(private readonly instant: Date) {
    super();
  }

  now(): Date {
    return new Date(this.instant);
  }
}

export function createClock(fixedIso: string | undefined): Clock {
  return fixedIso ? new FixedClock(new Date(fixedIso)) : new SystemClock();
}
