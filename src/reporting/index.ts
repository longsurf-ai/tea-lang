// Purpose: Public generic reporting surface.

export * from './report';
export {
  RunReportSink,
  SweepReportSink,
  composeOutputSinks,
  sweepReportSections,
  type SweepReportSnapshot,
} from '../providers/sinks/report-sink';
