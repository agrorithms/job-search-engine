import type { ATSConnector } from "./connectors/ats-connector";
import { GreenhouseConnector } from "./connectors/greenhouse";

const connectors: ReadonlyMap<string, ATSConnector> = new Map([
    ["greenhouse", new GreenhouseConnector()],
]);

export function getConnector(provider: string): ATSConnector {
    const connector = connectors.get(provider);

    if (!connector) {
        throw new Error(`Unsupported ATS provider: ${provider}`);
    }

    return connector;
}
