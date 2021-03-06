import { Utils } from '../utils';
import { MetadataStorage } from '../metadata';
import { AnyEntity, EntityData, EntityProperty, Primary } from '../typings';
import { ChangeSet, ChangeSetType } from './ChangeSet';
import { Collection, EntityIdentifier, EntityValidator, ReferenceType } from '../entity';
import { Platform } from '../platforms';

export class ChangeSetComputer {

  constructor(private readonly validator: EntityValidator,
              private readonly originalEntityData: Map<string, EntityData<AnyEntity>>,
              private readonly identifierMap: Map<string, EntityIdentifier>,
              private readonly collectionUpdates: Collection<AnyEntity>[],
              private readonly removeStack: Set<AnyEntity>,
              private readonly metadata: MetadataStorage,
              private readonly platform: Platform) { }

  computeChangeSet<T extends AnyEntity<T>>(entity: T): ChangeSet<T> | null {
    const changeSet = { entity } as ChangeSet<T>;
    const meta = this.metadata.find(entity.constructor.name)!;

    if (meta.readonly) {
      return null;
    }

    changeSet.name = meta.name!;
    changeSet.type = this.originalEntityData.has(entity.__helper!.__uuid) ? ChangeSetType.UPDATE : ChangeSetType.CREATE;
    changeSet.collection = meta.collection;
    changeSet.payload = this.computePayload(entity);

    if (changeSet.type === ChangeSetType.UPDATE) {
      changeSet.originalEntity = this.originalEntityData.get(entity.__helper!.__uuid);
    }

    this.validator.validate<T>(changeSet.entity, changeSet.payload, meta);

    for (const prop of Object.values(meta.properties)) {
      this.processReference(changeSet, prop);
    }

    if (changeSet.type === ChangeSetType.UPDATE && Object.keys(changeSet.payload).length === 0) {
      return null;
    }

    return changeSet;
  }

  private computePayload<T extends AnyEntity<T>>(entity: T): EntityData<T> {
    if (this.originalEntityData.get(entity.__helper!.__uuid)) {
      return Utils.diffEntities<T>(this.originalEntityData.get(entity.__helper!.__uuid) as T, entity, this.metadata, this.platform);
    }

    return Utils.prepareEntity(entity, this.metadata, this.platform);
  }

  private processReference<T extends AnyEntity<T>>(changeSet: ChangeSet<T>, prop: EntityProperty<T>): void {
    const target = changeSet.entity[prop.name];

    // remove items from collection based on removeStack
    if (Utils.isCollection<T>(target) && target.isInitialized()) {
      target.getItems()
        .filter(item => this.removeStack.has(item))
        .forEach(item => target.remove(item));
    }

    if (Utils.isCollection(target)) { // m:n or 1:m
      this.processToMany(prop, changeSet);
    } else if (prop.reference !== ReferenceType.SCALAR && target) { // m:1 or 1:1
      this.processToOne(prop, changeSet);
    }

    if (prop.reference === ReferenceType.ONE_TO_ONE) {
      this.processOneToOne(prop, changeSet);
    }
  }

  private processToOne<T extends AnyEntity<T>>(prop: EntityProperty<T>, changeSet: ChangeSet<T>): void {
    const pks = this.metadata.find(prop.type)!.primaryKeys;
    const entity = changeSet.entity[prop.name] as unknown as T;
    const isToOneOwner = prop.reference === ReferenceType.MANY_TO_ONE || (prop.reference === ReferenceType.ONE_TO_ONE && prop.owner);

    if (isToOneOwner && pks.length === 1 && !Utils.isDefined(entity[pks[0]], true)) {
      changeSet.payload[prop.name] = this.identifierMap.get(entity.__helper!.__uuid);
    }
  }

  private processToMany<T extends AnyEntity<T>>(prop: EntityProperty<T>, changeSet: ChangeSet<T>): void {
    const target = changeSet.entity[prop.name] as unknown as Collection<any>;

    if (!target.isDirty()) {
      return;
    }

    if (prop.owner || target.getItems(false).filter(item => !item.__helper!.isInitialized()).length > 0) {
      this.collectionUpdates.push(target);
    } else {
      target.setDirty(false); // inverse side with only populated items, nothing to persist
    }
  }

  private processOneToOne<T extends AnyEntity<T>>(prop: EntityProperty<T>, changeSet: ChangeSet<T>): void {
    // check diff, if we had a value on 1:1 before and now it changed (nulled or replaced), we need to trigger orphan removal
    const data = this.originalEntityData.get(changeSet.entity.__helper!.__uuid) as EntityData<T>;
    const em = changeSet.entity.__helper!.__em;

    if (prop.orphanRemoval && data && data[prop.name] && prop.name in changeSet.payload && em) {
      const orphan = em.getReference(prop.type, data[prop.name] as Primary<T>);
      em.getUnitOfWork().scheduleOrphanRemoval(orphan);
    }
  }

}
