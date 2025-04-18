// *****************************************************************************
// Copyright (C) 2020 TypeFox and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import debounce from 'p-debounce';
import * as markdownit from '@theia/core/shared/markdown-it';
import * as DOMPurify from '@theia/core/shared/dompurify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { CancellationToken, CancellationTokenSource } from '@theia/core/lib/common/cancellation';
import { HostedPluginSupport } from '@theia/plugin-ext/lib/hosted/browser/hosted-plugin';
import { VSXExtension, VSXExtensionFactory } from './vsx-extension';
import { ProgressService } from '@theia/core/lib/common/progress-service';
import { VSXExtensionsSearchModel } from './vsx-extensions-search-model';
import { PreferenceInspectionScope, PreferenceService } from '@theia/core/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { RecommendedExtensions } from './recommended-extensions/recommended-extensions-preference-contribution';
import URI from '@theia/core/lib/common/uri';
import { OVSXClient, VSXAllVersions, VSXExtensionRaw, VSXResponseError, VSXSearchEntry, VSXSearchOptions, VSXTargetPlatform } from '@theia/ovsx-client/lib/ovsx-types';
import { OVSXClientProvider } from '../common/ovsx-client-provider';
import { RequestContext, RequestService } from '@theia/core/shared/@theia/request';
import { OVSXApiFilterProvider } from '@theia/ovsx-client';
import { ApplicationServer } from '@theia/core/lib/common/application-protocol';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { HostedPluginServer, PluginIdentifiers, PluginType } from '@theia/plugin-ext';
import { HostedPluginWatcher } from '@theia/plugin-ext/lib/hosted/browser/hosted-plugin-watcher';

@injectable()
export class VSXExtensionsModel {
    protected initialized: Promise<void>;
    /**
     * Single source for all extensions
     */
    protected readonly extensions = new Map<string, VSXExtension>();
    protected readonly onDidChangeEmitter = new Emitter<void>();
    protected disabled = new Set<PluginIdentifiers.UnversionedId>();
    protected uninstalled = new Set<PluginIdentifiers.UnversionedId>();
    protected deployed = new Set<PluginIdentifiers.UnversionedId>();
    protected _installed = new Set<PluginIdentifiers.UnversionedId>();
    protected _recommended = new Set<string>();
    protected _searchResult = new Set<string>();
    protected builtins = new Set<PluginIdentifiers.UnversionedId>();
    protected _searchError?: string;

    protected searchCancellationTokenSource = new CancellationTokenSource();
    protected updateSearchResult = debounce(async () => {
        const { token } = this.resetSearchCancellationTokenSource();
        await this.doUpdateSearchResult({ query: this.search.query, includeAllVersions: true }, token);
    }, 500);

    @inject(OVSXClientProvider)
    protected clientProvider: OVSXClientProvider;

    @inject(HostedPluginSupport)
    protected readonly pluginSupport: HostedPluginSupport;

    @inject(HostedPluginWatcher)
    protected pluginWatcher: HostedPluginWatcher;

    @inject(HostedPluginServer)
    protected readonly pluginServer: HostedPluginServer;

    @inject(VSXExtensionFactory)
    protected readonly extensionFactory: VSXExtensionFactory;

    @inject(ProgressService)
    protected readonly progressService: ProgressService;

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(VSXExtensionsSearchModel)
    readonly search: VSXExtensionsSearchModel;

    @inject(RequestService)
    protected request: RequestService;

    @inject(OVSXApiFilterProvider)
    protected vsxApiFilter: OVSXApiFilterProvider;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(ApplicationServer)
    protected readonly applicationServer: ApplicationServer;

    @postConstruct()
    protected init(): void {
        this.initialized = this.doInit().catch(console.error);
    }

    protected async doInit(): Promise<void> {
        await Promise.all([
            this.initInstalled(),
            this.initSearchResult(),
            this.initRecommended(),
        ]);
    }

    get onDidChange(): Event<void> {
        return this.onDidChangeEmitter.event;
    }

    get installed(): IterableIterator<string> {
        return this._installed.values();
    }

    get searchError(): string | undefined {
        return this._searchError;
    }

    get searchResult(): IterableIterator<string> {
        return this._searchResult.values();
    }

    get recommended(): IterableIterator<string> {
        return this._recommended.values();
    }

    setOnlyShowVerifiedExtensions(bool: boolean): void {
        if (this.preferences.get('extensions.onlyShowVerifiedExtensions') !== bool) {
            this.preferences.updateValue('extensions.onlyShowVerifiedExtensions', bool);
        }
        this.updateSearchResult();
    }

    isBuiltIn(id: string): boolean {
        return this.builtins.has(id as PluginIdentifiers.UnversionedId);
    }

    isInstalled(id: string): boolean {
        return this._installed.has(id as PluginIdentifiers.UnversionedId);
    }

    isUninstalled(id: string): boolean {
        return this.uninstalled.has(id as PluginIdentifiers.UnversionedId);
    }

    isDeployed(id: string): boolean {
        return this.deployed.has(id as PluginIdentifiers.UnversionedId);
    }

    isDisabled(id: string): boolean {
        return this.disabled.has(id as PluginIdentifiers.UnversionedId);
    }

    getExtension(id: string): VSXExtension | undefined {
        return this.extensions.get(id);
    }

    resolve(id: string): Promise<VSXExtension> {
        return this.doChange(async () => {
            await this.initialized;
            const extension = await this.refresh(id) ?? this.getExtension(id);
            if (!extension) {
                throw new Error(`Failed to resolve ${id} extension.`);
            }
            if (extension.readme === undefined) {
                try {
                    let rawReadme: string = '';
                    const installedReadme = await this.findReadmeFile(extension);
                    // Attempt to read the local readme first
                    // It saves network resources and is faster
                    if (installedReadme) {
                        const readmeContent = await this.fileService.readFile(installedReadme);
                        rawReadme = readmeContent.value.toString();
                    } else if (extension.readmeUrl) {
                        rawReadme = RequestContext.asText(
                            await this.request.request({ url: extension.readmeUrl })
                        );
                    }
                    const readme = this.compileReadme(rawReadme);
                    extension.update({ readme });
                } catch (e) {
                    if (!VSXResponseError.is(e) || e.statusCode !== 404) {
                        console.error(`[${id}]: failed to compile readme, reason:`, e);
                    }
                }
            }
            return extension;
        });
    }

    protected async findReadmeFile(extension: VSXExtension): Promise<URI | undefined> {
        if (!extension.plugin) {
            return undefined;
        }
        // Since we don't know the exact capitalization of the readme file (might be README.md, readme.md, etc.)
        // We attempt to find the readme file by searching through the plugin's directories
        const packageUri = new URI(extension.plugin.metadata.model.packageUri);
        const pluginUri = packageUri.withPath(packageUri.path.join('..'));
        const pluginDirStat = await this.fileService.resolve(pluginUri);
        const possibleNames = ['readme.md', 'readme.txt', 'readme'];
        const readmeFileUri = pluginDirStat.children
            ?.find(child => possibleNames.includes(child.name.toLowerCase()))
            ?.resource;
        return readmeFileUri;
    }

    protected async initInstalled(): Promise<void> {
        await this.pluginSupport.willStart;
        try {
            await this.updateInstalled();
        } catch (e) {
            console.error(e);
        }

        this.pluginWatcher.onDidDeploy(() => {
            this.updateInstalled();
        });
    }

    protected async initSearchResult(): Promise<void> {
        this.search.onDidChangeQuery(() => this.updateSearchResult());
        try {
            await this.updateSearchResult();
        } catch (e) {
            console.error(e);
        }
    }

    protected async initRecommended(): Promise<void> {
        this.preferences.onPreferenceChanged(change => {
            if (change.preferenceName === 'extensions') {
                this.updateRecommended();
            }
        });
        await this.preferences.ready;
        try {
            await this.updateRecommended();
        } catch (e) {
            console.error(e);
        }
    }

    protected resetSearchCancellationTokenSource(): CancellationTokenSource {
        this.searchCancellationTokenSource.cancel();
        return this.searchCancellationTokenSource = new CancellationTokenSource();
    }

    protected setExtension(id: string, version?: string): VSXExtension {
        let extension = this.extensions.get(id);
        if (!extension) {
            extension = this.extensionFactory({ id, version, model: this });
            this.extensions.set(id, extension);
        }
        return extension;
    }

    protected doChange<T>(task: () => Promise<T>): Promise<T>;
    protected doChange<T>(task: () => Promise<T>, token: CancellationToken): Promise<T | undefined>;
    protected doChange<T>(task: () => Promise<T>, token: CancellationToken = CancellationToken.None): Promise<T | undefined> {
        return this.progressService.withProgress('', 'extensions', async () => {
            if (token && token.isCancellationRequested) {
                return;
            }
            const result = await task();
            if (token && token.isCancellationRequested) {
                return;
            }
            this.onDidChangeEmitter.fire();
            return result;
        });
    }

    protected doUpdateSearchResult(param: VSXSearchOptions, token: CancellationToken): Promise<void> {
        return this.doChange(async () => {
            this._searchResult = new Set<string>();
            if (!param.query) {
                return;
            }
            const client = await this.clientProvider();
            const filter = await this.vsxApiFilter();
            try {
                const result = await client.search(param);

                if (token.isCancellationRequested) {
                    return;
                }
                for (const data of result.extensions) {
                    const id = data.namespace.toLowerCase() + '.' + data.name.toLowerCase();
                    const allVersions = filter.getLatestCompatibleVersion(data);
                    if (!allVersions) {
                        continue;
                    }
                    if (this.preferences.get('extensions.onlyShowVerifiedExtensions')) {
                        this.fetchVerifiedStatus(id, client, allVersions).then(verified => {
                            this.doChange(() => {
                                this.addExtensions(data, id, allVersions, !!verified);
                                return Promise.resolve();
                            });
                        });
                    } else {
                        this.addExtensions(data, id, allVersions);
                        this.fetchVerifiedStatus(id, client, allVersions).then(verified => {
                            this.doChange(() => {
                                let extension = this.getExtension(id);
                                extension = this.setExtension(id);
                                extension.update(Object.assign({
                                    verified: verified
                                }));
                                return Promise.resolve();
                            });
                        });
                    }
                }
            } catch (error) {
                this._searchError = error?.message || String(error);
            }

        }, token);
    }

    protected async fetchVerifiedStatus(id: string, client: OVSXClient, allVersions: VSXAllVersions): Promise<boolean | undefined> {
        try {
            const res = await client.query({ extensionId: id, extensionVersion: allVersions.version, includeAllVersions: true });
            const extension = res.extensions?.[0];
            let verified = extension?.verified;
            if (!verified && extension?.publishedBy.loginName === 'open-vsx') {
                verified = true;
            }
            return verified;
        } catch (error) {
            console.error(error);
            return false;
        }
    }

    protected addExtensions(data: VSXSearchEntry, id: string, allVersions: VSXAllVersions, verified?: boolean): void {
        if (!this.preferences.get('extensions.onlyShowVerifiedExtensions') || verified) {
            const extension = this.setExtension(id);
            extension.update(Object.assign(data, {
                publisher: data.namespace,
                downloadUrl: data.files.download,
                iconUrl: data.files.icon,
                readmeUrl: data.files.readme,
                licenseUrl: data.files.license,
                version: allVersions.version,
                verified: verified
            }));
            this._searchResult.add(id);
        }
    }

    protected async updateInstalled(): Promise<void> {
        const [deployed, uninstalled, disabled] = await Promise.all(
            [this.pluginServer.getDeployedPluginIds(), this.pluginServer.getUninstalledPluginIds(), this.pluginServer.getDisabledPluginIds()]);

        this.uninstalled = new Set();
        uninstalled.forEach(id => this.uninstalled.add(PluginIdentifiers.unversionedFromVersioned(id)));
        this.disabled = new Set();
        disabled.forEach(id => this.disabled.add(PluginIdentifiers.unversionedFromVersioned(id)));
        this.deployed = new Set();
        deployed.forEach(id => this.deployed.add(PluginIdentifiers.unversionedFromVersioned(id)));

        const prevInstalled = this._installed;
        const installedVersioned = new Set<PluginIdentifiers.VersionedId>();
        return this.doChange(async () => {
            const currInstalled = new Set<PluginIdentifiers.UnversionedId>();
            const refreshing = [];
            for (const versionedId of deployed) {
                installedVersioned.add(versionedId);
                const idAndVersion = PluginIdentifiers.idAndVersionFromVersionedId(versionedId);
                if (idAndVersion) {
                    this._installed.delete(idAndVersion.id);
                    this.setExtension(idAndVersion.id, idAndVersion.version);
                    currInstalled.add(idAndVersion.id);
                    refreshing.push(this.refresh(idAndVersion.id, idAndVersion.version));
                }
            }
            for (const versionedId of disabled) {
                const idAndVersion = PluginIdentifiers.idAndVersionFromVersionedId(versionedId);
                installedVersioned.add(versionedId);
                if (idAndVersion && !this.isUninstalled(idAndVersion.id)) {
                    if (!currInstalled.has(idAndVersion.id)) {
                        this._installed.delete(idAndVersion.id);
                        this.setExtension(idAndVersion.id, idAndVersion.version);
                        currInstalled.add(idAndVersion.id);
                        refreshing.push(this.refresh(idAndVersion.id, idAndVersion.version));
                    }
                }
            }
            for (const id of this._installed) {
                const extension = this.getExtension(id);
                if (!extension) { continue; }
                refreshing.push(this.refresh(id, extension.version));
            }
            await Promise.all(refreshing);
            const installed = new Set([...prevInstalled, ...currInstalled]);
            const installedSorted = Array.from(installed).sort((a, b) => this.compareExtensions(a, b));
            this._installed = new Set(installedSorted.values());

            const missingIds = new Set<PluginIdentifiers.VersionedId>();
            for (const id of installedVersioned) {
                const unversionedId = PluginIdentifiers.unversionedFromVersioned(id);
                const plugin = this.pluginSupport.getPlugin(unversionedId);
                if (plugin) {
                    if (plugin.type === PluginType.System) {
                        this.builtins.add(unversionedId);
                    } else {
                        this.builtins.delete(unversionedId);
                    }
                } else {
                    missingIds.add(id);
                }
            }
            const missing = await this.pluginServer.getDeployedPlugins([...missingIds.values()]);
            for (const plugin of missing) {
                if (plugin.type === PluginType.System) {
                    this.builtins.add(PluginIdentifiers.componentsToUnversionedId(plugin.metadata.model));
                } else {
                    this.builtins.delete(PluginIdentifiers.componentsToUnversionedId(plugin.metadata.model));
                }
            }
        });
    }

    protected updateRecommended(): Promise<Array<VSXExtension | undefined>> {
        return this.doChange<Array<VSXExtension | undefined>>(async () => {
            const allRecommendations = new Set<string>();
            const allUnwantedRecommendations = new Set<string>();

            const updateRecommendationsForScope = (scope: PreferenceInspectionScope, root?: URI) => {
                const { recommendations, unwantedRecommendations } = this.getRecommendationsForScope(scope, root);
                recommendations.forEach(recommendation => allRecommendations.add(recommendation.toLowerCase()));
                unwantedRecommendations.forEach(unwantedRecommendation => allUnwantedRecommendations.add(unwantedRecommendation));
            };

            updateRecommendationsForScope('defaultValue'); // In case there are application-default recommendations.
            const roots = await this.workspaceService.roots;
            for (const root of roots) {
                updateRecommendationsForScope('workspaceFolderValue', root.resource);
            }
            if (this.workspaceService.saved) {
                updateRecommendationsForScope('workspaceValue');
            }
            const recommendedSorted = new Set(Array.from(allRecommendations).sort((a, b) => this.compareExtensions(a, b)));
            allUnwantedRecommendations.forEach(unwantedRecommendation => recommendedSorted.delete(unwantedRecommendation));
            this._recommended = recommendedSorted;
            return Promise.all(Array.from(recommendedSorted, plugin => this.refresh(plugin)));
        });
    }

    protected getRecommendationsForScope(scope: PreferenceInspectionScope, root?: URI): Required<RecommendedExtensions> {
        const configuredValue = this.preferences.inspect<Required<RecommendedExtensions>>('extensions', root?.toString())?.[scope];
        return {
            recommendations: configuredValue?.recommendations ?? [],
            unwantedRecommendations: configuredValue?.unwantedRecommendations ?? [],
        };
    }

    protected compileReadme(readmeMarkdown: string): string {
        const readmeHtml = markdownit({ html: true }).render(readmeMarkdown);
        return DOMPurify.sanitize(readmeHtml);
    }

    protected async refresh(id: string, version?: string): Promise<VSXExtension | undefined> {
        try {
            let extension = this.getExtension(id);
            if (!this.shouldRefresh(extension)) {
                return extension;
            }
            const filter = await this.vsxApiFilter();
            const targetPlatform = await this.applicationServer.getApplicationPlatform() as VSXTargetPlatform;
            let data: VSXExtensionRaw | undefined;
            if (version === undefined) {
                data = await filter.findLatestCompatibleExtension({
                    extensionId: id,
                    includeAllVersions: true,
                    targetPlatform
                });
            } else {
                data = await filter.findLatestCompatibleExtension({
                    extensionId: id,
                    extensionVersion: version,
                    includeAllVersions: true,
                    targetPlatform
                });
            }
            if (!data) {
                return;
            }
            if (data.error) {
                return this.onDidFailRefresh(id, data.error);
            }
            if (!data.verified) {
                if (data.publishedBy.loginName === 'open-vsx') {
                    data.verified = true;
                }
            }
            extension = this.setExtension(id);
            extension.update(Object.assign(data, {
                publisher: data.namespace,
                downloadUrl: data.files.download,
                iconUrl: data.files.icon,
                readmeUrl: data.files.readme,
                licenseUrl: data.files.license,
                version: data.version,
                verified: data.verified
            }));
            return extension;
        } catch (e) {
            return this.onDidFailRefresh(id, e);
        }
    }

    /**
     * Determines if the given extension should be refreshed.
     * @param extension the extension to refresh.
     */
    protected shouldRefresh(extension?: VSXExtension): boolean {
        return extension === undefined || extension.plugin === undefined;
    }

    protected onDidFailRefresh(id: string, error: unknown): VSXExtension | undefined {
        const cached = this.getExtension(id);
        if (cached && cached.deployed) {
            return cached;
        }
        console.error(`[${id}]: failed to refresh, reason:`, error);
        return undefined;
    }

    /**
     * Compare two extensions based on their display name, and publisher if applicable.
     * @param a the first extension id for comparison.
     * @param b the second extension id for comparison.
     */
    protected compareExtensions(a: string, b: string): number {
        const extensionA = this.getExtension(a);
        const extensionB = this.getExtension(b);
        if (!extensionA || !extensionB) {
            return 0;
        }
        if (extensionA.displayName && extensionB.displayName) {
            return extensionA.displayName.localeCompare(extensionB.displayName);
        }
        if (extensionA.publisher && extensionB.publisher) {
            return extensionA.publisher.localeCompare(extensionB.publisher);
        }
        return 0;
    }

}
