// Purpose: Public generic reporting surface.

export * from './report';
export * from './execution-result';
export * from './sweep';
export * from './trajectory';
export {
  RunReportSink,
  SweepReportSink,
  composeOutputSinks,
  sweepReportSections,
} from '../providers/sinks/report-sink';
export {
  TrajectoryArchive,
  TrajectoryArchiveBudgetError,
  TrajectoryArchiveProjectionBudgetError,
  TrajectoryArchiveSink,
  TrajectoryArchiveUnsupportedTransportError,
  type TrajectoryArchiveOptions,
} from '../providers/sinks/trajectory-archive';
