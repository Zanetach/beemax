import {
	DeterministicWorkContractBuilder,
	ModelBackedWorkContractBuilder,
	PiWorkContractBuilder,
	type ThruveraAgentRuntimeOptions,
	type WorkContractBuilderPort,
	type WorkContractProposalBuilderPort,
} from "../../dist/index.js";

type Assert<T extends true> = T;
type IsAssignable<From, To> = From extends To ? true : false;
type IsNotAssignable<From, To> = From extends To ? false : true;

type ModelBackedIsProposalOnly = Assert<IsAssignable<ModelBackedWorkContractBuilder, WorkContractProposalBuilderPort>>;
type ModelBackedIsNotRuntime = Assert<IsNotAssignable<ModelBackedWorkContractBuilder, WorkContractBuilderPort>>;
type PiIsRuntime = Assert<IsAssignable<PiWorkContractBuilder, WorkContractBuilderPort>>;
type DeterministicIsRuntime = Assert<IsAssignable<DeterministicWorkContractBuilder, WorkContractBuilderPort>>;
type StandaloneRuntimeBuilderRemainsOptional = Assert<{} extends Pick<ThruveraAgentRuntimeOptions, "workContractBuilder"> ? true : false>;

export type WorkContractPortTypeAssertions =
	| ModelBackedIsProposalOnly
	| ModelBackedIsNotRuntime
	| PiIsRuntime
	| DeterministicIsRuntime
	| StandaloneRuntimeBuilderRemainsOptional;
