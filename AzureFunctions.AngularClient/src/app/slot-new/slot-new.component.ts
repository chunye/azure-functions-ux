import { DashboardType } from 'app/tree-view/models/dashboard-type';
import { LogCategories } from 'app/shared/models/constants';
import { LogService } from './../shared/services/log.service';
import { Component, Injector, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs/Subject';
import { Observable } from 'rxjs/Observable';
import { FormBuilder, FormGroup } from '@angular/forms';
import { TranslateService } from '@ngx-translate/core';
import 'rxjs/add/operator/mergeMap';

import { SiteService } from '../shared/services/slots.service';
import { SlotsNode } from '../tree-view/slots-node';
import { TreeViewInfo } from '../tree-view/models/tree-view-info';
import { GlobalStateService } from '../shared/services/global-state.service';
import { BroadcastService } from '../shared/services/broadcast.service';
import { AiService } from '../shared/services/ai.service';
import { CacheService } from '../shared/services/cache.service';
import { ArmObj } from '../shared/models/arm/arm-obj';
import { Site } from '../shared/models/arm/site';
import { PortalService } from '../shared/services/portal.service';
import { Constants } from '../shared/models/constants';
import { AppNode } from '../tree-view/app-node';
import { RequiredValidator } from '../shared/validators/requiredValidator';
import { PortalResources } from '../shared/models/portal-resources';
import { SlotNameValidator } from '../shared/validators/slotNameValidator';
import { BroadcastEvent } from '../shared/models/broadcast-event';
import { ErrorIds } from '../shared/models/error-ids';
import { ErrorType, ErrorEvent } from '../shared/models/error-event';
import { AuthzService } from '../shared/services/authz.service';

interface DataModel {
    writePermission: boolean;
    readOnlyLock: boolean;
    siteInfo: any;
    appSettings: any;
    slotsList: ArmObj<Site>[];
}

@Component({
    selector: 'slot-new',
    templateUrl: './slot-new.component.html',
    styleUrls: ['./slot-new.component.scss'],
})
export class SlotNewComponent implements OnDestroy {
    public Resources = PortalResources;
    public slotOptinEnabled: boolean;
    public hasCreatePermissions: boolean;
    public newSlotForm: FormGroup;
    public slotNamePlaceholder: string;
    public hasReachedDynamicQuotaLimit: boolean;
    public isLoading = true;

    private _slotsNode: SlotsNode;
    private _viewInfo: TreeViewInfo<any>;
    private _siteId: string;
    private _slotsList: ArmObj<Site>[];
    private _siteObj: ArmObj<Site>;
    private _ngUnsubscribe: Subject<void> = new Subject<void>();

    constructor(fb: FormBuilder,
        private _globalStateService: GlobalStateService,
        private _translateService: TranslateService,
        private _broadcastService: BroadcastService,
        private _portalService: PortalService,
        private _aiService: AiService,
        private _slotService: SiteService,
        private _cacheService: CacheService,
        private _logService: LogService,
        authZService: AuthzService,
        injector: Injector) {
        const validator = new RequiredValidator(this._translateService);

        this._broadcastService.getEvents<TreeViewInfo<any>>(BroadcastEvent.TreeNavigation)
            .filter(info => info.dashboardType === DashboardType.CreateSlotDashboard)
            .takeUntil(this._ngUnsubscribe)
            .switchMap(viewInfo => {
                this._globalStateService.setBusyState();
                this._slotsNode = <SlotsNode>viewInfo.node;
                this._viewInfo = viewInfo;

                // parse the site resourceId from slot's
                this._siteId = viewInfo.resourceId.substring(0, viewInfo.resourceId.indexOf('/slots'));
                const slotNameValidator = new SlotNameValidator(injector, this._siteId);
                this.newSlotForm = fb.group({
                    name: [null,
                        validator.validate.bind(validator),
                        slotNameValidator.validate.bind(slotNameValidator)]
                });

                return Observable.zip<DataModel>(
                    authZService.hasPermission(this._siteId, [AuthzService.writeScope]),
                    authZService.hasReadOnlyLock(this._siteId),
                    this._cacheService.getArm(this._siteId),
                    this._slotService.getSlotsList(this._siteId),
                    (w, rl, s, l) => ({
                        writePermission: w,
                        readOnlyLock: rl,
                        siteInfo: s,
                        slotsList: l
                    }));
            })
            .mergeMap(res => {
                this.hasCreatePermissions = res.writePermission && !res.readOnlyLock;
                if (this.hasCreatePermissions) {
                    return this._cacheService.postArm(`${this._siteId}/config/appsettings/list`, true)
                        .map(r => {
                            res.appSettings = r.json();
                            return res;
                        });
                }
                return Observable.of(res);
            })
            .do(null, e => {
                // log error & clear busy state
                this._logService.error(LogCategories.newSlot, '/slot-new', e);
                this._globalStateService.clearBusyState();
            })
            .retry()
            .subscribe(res => {
                this._siteObj = <ArmObj<Site>>res.siteInfo.json();
                const sku = this._siteObj.properties.sku;
                this._slotsList = <ArmObj<Site>[]>res.slotsList;
                this.slotOptinEnabled = res.slotsList.length > 0 ||
                    res.appSettings.properties[Constants.slotsSecretStorageSettingsName] === Constants.slotsSecretStorageSettingsValue;
                this.hasReachedDynamicQuotaLimit = !!sku && sku.toLowerCase() === 'dynamic' && this._slotsList.length === 1;
                this._globalStateService.clearBusyState();
                this.isLoading = false;
            });
    }

    ngOnDestroy() {
        this._ngUnsubscribe.next();
    }

    onFunctionAppSettingsClicked() {
        const appNode = <AppNode>this._slotsNode.parent;
        appNode.openSettings();
    }

    createSlot() {
        const newSlotName = this.newSlotForm.controls['name'].value;
        let notificationId = null;
        this._globalStateService.setBusyState();
        // show create slot start notification
        this._portalService.startNotification(
            this._translateService.instant(PortalResources.slotNew_startCreateNotifyTitle).format(newSlotName),
            this._translateService.instant(PortalResources.slotNew_startCreateNotifyTitle).format(newSlotName))
            .first()
            .switchMap(s => {
                notificationId = s.id;
                return this._slotService.createNewSlot(this._siteObj.id, newSlotName, this._siteObj.location, this._siteObj.properties.serverFarmId);
            })
            .subscribe((r) => {
                this._globalStateService.clearBusyState();
                // update notification
                this._portalService.stopNotification(
                    notificationId,
                    true,
                    this._translateService.instant(PortalResources.slotNew_startCreateSuccessNotifyTitle).format(newSlotName));
                let slotsNode = <SlotsNode>this._viewInfo.node;

                // If someone refreshed the app, it would created a new set of child nodes under the app node.
                slotsNode = <SlotsNode>this._viewInfo.node.parent.children.find(node => node.title === slotsNode.title);
                slotsNode.addChild(<ArmObj<Site>>r.json());
                slotsNode.isExpanded = true;
            }, err => {
                this._globalStateService.clearBusyState();
                this._portalService.stopNotification(
                    notificationId,
                    false,
                    this._translateService.instant(PortalResources.slotNew_startCreateFailureNotifyTitle).format(newSlotName));
                this._broadcastService.broadcast<ErrorEvent>(
                    BroadcastEvent.Error, {
                        message: this._translateService.instant(PortalResources.slotNew_startCreateFailureNotifyTitle).format(newSlotName),
                        details: this._translateService.instant(PortalResources.slotNew_startCreateFailureNotifyTitle).format(newSlotName),
                        errorId: ErrorIds.failedToCreateSlot,
                        errorType: ErrorType.Fatal,
                        resourceId: this._siteObj.id
                    });
                this._aiService.trackEvent(ErrorIds.failedToCreateApp, { error: err, id: this._siteObj.id });
            });
    }
}
