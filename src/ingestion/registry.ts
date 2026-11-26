import type { ATSConnector } from "./connectors/ats-connector";
import { GreenhouseConnector } from "./connectors/greenhouse";
import { LeverConnector } from "./connectors/lever";

const connectors: ReadonlyMap<string, ATSConnector> = new Map<string, ATSConnector>([
    ["greenhouse", new GreenhouseConnector()],
    ["lever", new LeverConnector()],
]);

export function getConnector(provider: string): ATSConnector {
    const connector = connectors.get(provider);

    if (!connector) {
        throw new Error(`Unsupported ATS provider: ${provider}`);
    }

    return connector;
}
