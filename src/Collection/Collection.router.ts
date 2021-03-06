import { server } from 'decentraland-server'
import { Router } from '../common/Router'
import { HTTPError, STATUS_CODES } from '../common/HTTPError'
import { getValidator } from '../utils/validator'
import {
  withModelAuthorization,
  withAuthentication,
  withModelExists,
  withLowercasedParams,
  AuthRequest,
} from '../middleware'
import { collectionAPI } from '../ethereum/api/collection'
import { Bridge } from '../ethereum/api/Bridge'
import { peerAPI, Wearable } from '../ethereum/api/peer'
import { FactoryCollection } from '../ethereum'
import { Ownable } from '../Ownable'
import { Item, ItemAttributes } from '../Item'
import {
  Collection,
  CollectionService,
  CollectionAttributes,
} from '../Collection'
import { isCommitteeMember } from '../Committee'
import { collectionSchema, saveTOSSchema } from './Collection.types'
import { RequestParameters } from '../RequestParameters'
import { hasAccess } from './access'
import { ItemFragment } from '../ethereum/api/fragments'
import { sendDataToWarehouse } from '../warehouse'

const validator = getValidator()

export class CollectionRouter extends Router {
  public service = new CollectionService()

  mount() {
    const withCollectionExists = withModelExists(Collection, 'id')
    const withCollectionAuthorization = withModelAuthorization(Collection)
    const withLowercasedAddress = withLowercasedParams(['address'])

    /**
     * Returns all collections
     */
    this.router.get(
      '/collections',
      withAuthentication,
      server.handleRequest(this.getCollections)
    )

    /**
     * Returns the collections for an address
     */
    this.router.get(
      '/:address/collections',
      withAuthentication,
      withLowercasedAddress,
      server.handleRequest(this.getAddressCollections)
    )

    /**
     * Returns a collection
     */
    this.router.get(
      '/collections/:id',
      withCollectionExists,
      server.handleRequest(this.getCollection)
    )

    /**
     * Handle the publication of a collection to the blockchain
     */
    this.router.post(
      '/collections/:id/publish',
      withAuthentication,
      withCollectionExists,
      server.handleRequest(this.publishCollection)
    )

    /**
     * Handle the storage of the TOS of a collection publication
     */
    this.router.post(
      '/collections/:id/tos',
      withAuthentication,
      withCollectionExists,
      server.handleRequest(this.saveTOS)
    )

    /**
     * Lock a collection until is published
     */
    this.router.post(
      '/collections/:id/lock',
      withAuthentication,
      withCollectionExists,
      withCollectionAuthorization,
      server.handleRequest(this.lockCollection)
    )

    /**
     * Upserts the collection
     * Important! Collection authorization is done inside the handler
     */
    this.router.put(
      '/collections/:id',
      withAuthentication,
      server.handleRequest(this.upsertCollection)
    )

    /**
     * Deletes the collection
     */
    this.router.delete(
      '/collections/:id',
      withAuthentication,
      withCollectionExists,
      withCollectionAuthorization,
      server.handleRequest(this.deleteCollection)
    )
  }

  async getCollections(req: AuthRequest) {
    const eth_address = req.auth.ethAddress
    const canRequestCollections = await isCommitteeMember(eth_address)

    if (!canRequestCollections) {
      throw new HTTPError(
        'Unauthorized',
        { eth_address },
        STATUS_CODES.unauthorized
      )
    }

    let is_published: boolean | undefined
    try {
      is_published = new RequestParameters(req).getBoolean('isPublished')
    } catch (error) {
      // No is_published param
    }

    // The current implementation only supports fetching published/unpublished collections and items
    // If, in the future we need to add multiple query params, a more flexible implementation is required
    const [dbCollections, remoteCollections] = await Promise.all([
      typeof is_published === 'undefined'
        ? Collection.find<CollectionAttributes>()
        : Collection.find<CollectionAttributes>({ is_published }),
      collectionAPI.fetchCollections(),
    ])

    return Bridge.consolidateCollections(dbCollections, remoteCollections)
  }

  async getAddressCollections(req: AuthRequest) {
    const eth_address = server.extractFromReq(req, 'address')
    const auth_address = req.auth.ethAddress

    if (eth_address !== auth_address) {
      throw new HTTPError(
        'Unauthorized',
        { eth_address },
        STATUS_CODES.unauthorized
      )
    }

    const [dbCollections, remoteCollections] = await Promise.all([
      Collection.find<CollectionAttributes>({ eth_address }),
      collectionAPI.fetchCollectionsByAuthorizedUser(eth_address),
    ])
    return Bridge.consolidateCollections(dbCollections, remoteCollections)
  }

  async getCollection(req: AuthRequest) {
    const id = server.extractFromReq(req, 'id')
    const eth_address = req.auth.ethAddress

    const dbCollection = await Collection.findOne<CollectionAttributes>(id)
    if (!dbCollection) {
      throw new HTTPError(
        'Not found',
        { id, eth_address },
        STATUS_CODES.notFound
      )
    }

    const remoteCollection = await collectionAPI.fetchCollection(
      dbCollection.contract_address
    )

    const fullCollection = remoteCollection
      ? Bridge.mergeCollection(dbCollection, remoteCollection)
      : dbCollection

    if (!(await hasAccess(eth_address, fullCollection))) {
      throw new HTTPError(
        'Unauthorized',
        { id, eth_address },
        STATUS_CODES.unauthorized
      )
    }

    return fullCollection
  }

  publishCollection = async (req: AuthRequest) => {
    const id = server.extractFromReq(req, 'id')

    // We are using the withCollectionExists middleware so we can safely assert the collection exists
    const [dbCollection, dbItems] = await Promise.all([
      Collection.findOne<CollectionAttributes>(id),
      Item.findOrderedItemsByCollectionId(id),
    ])
    const remoteCollection = await collectionAPI.fetchCollection(
      dbCollection!.contract_address
    )

    if (!remoteCollection) {
      // This might be a problem with the graph lagging but we delegate the retry logic on the client
      throw new HTTPError(
        'The collection is not published yet',
        { id },
        STATUS_CODES.unauthorized
      )
    }

    const items: ItemAttributes[] = [...dbItems]
    let remoteItems: ItemFragment[] = []
    let catalystItems: Wearable[] = []

    const isMissingBlockchainItemIds = dbItems.some(
      (item) => item.blockchain_item_id == null
    )

    if (isMissingBlockchainItemIds) {
      const fetches = await Promise.all([
        collectionAPI.fetchItemsByContractAddress(
          dbCollection!.contract_address
        ),
        peerAPI.fetchWearables(remoteItems.map((item) => item.urn)),
      ])
      const updates = []

      remoteItems = fetches[0]
      catalystItems = fetches[1]

      for (const [index, remoteItem] of remoteItems.entries()) {
        updates.push(
          Item.update(
            { blockchain_item_id: remoteItem.blockchainId },
            { id: dbItems[index].id }
          )
        )
        items[index].blockchain_item_id = remoteItem.blockchainId
      }

      await Promise.all(updates)
    }

    return {
      collection: await Bridge.consolidateCollections(
        [dbCollection!],
        [remoteCollection]
      ),
      items: await Bridge.consolidateItems(items, remoteItems, catalystItems),
    }
  }

  saveTOS = async (req: AuthRequest) => {
    const tosValidator = validator.compile(saveTOSSchema)
    tosValidator(req.body)
    if (tosValidator.errors) {
      throw new HTTPError(
        'Invalid request',
        tosValidator.errors,
        STATUS_CODES.badRequest
      )
    }

    const eth_address = req.auth.ethAddress
    try {
      await sendDataToWarehouse('builder', 'publish_collection_tos', {
        email: req.body.email,
        eth_address: eth_address,
        collection_address: req.body.collection_address,
      })
    } catch (e) {
      throw new HTTPError(
        "The TOS couldn't be recorded",
        null,
        STATUS_CODES.error
      )
    }
  }

  lockCollection = async (req: AuthRequest) => {
    const id = server.extractFromReq(req, 'id')
    const eth_address = req.auth.ethAddress

    try {
      const lock = new Date(Date.now())
      await Collection.update({ lock }, { id, eth_address })
      return lock
    } catch (error) {
      throw new HTTPError(
        "The collection couldn't be updated",
        { id, eth_address, error: (error as Error).message },
        STATUS_CODES.error
      )
    }
  }

  upsertCollection = async (req: AuthRequest) => {
    const id = server.extractFromReq(req, 'id')
    const collectionJSON: any = server.extractFromReq(req, 'collection')
    const data: string = server.extractFromReq(req, 'data')
    const eth_address = req.auth.ethAddress

    const validate = validator.compile(collectionSchema)
    validate(collectionJSON)

    if (validate.errors) {
      throw new HTTPError('Invalid schema', validate.errors)
    }

    if (collectionJSON.is_published || collectionJSON.is_approved) {
      throw new HTTPError(
        'Can not change is_published or is_approved property',
        { id, eth_address },
        STATUS_CODES.unauthorized
      )
    }

    const canUpsert = await new Ownable(Collection).canUpsert(id, eth_address)
    if (!canUpsert) {
      throw new HTTPError(
        'Unauthorized',
        { id, eth_address },
        STATUS_CODES.unauthorized
      )
    }

    const attributes = {
      ...collectionJSON,
      eth_address,
    } as CollectionAttributes

    if (!(await Collection.isValidName(id, attributes.name.trim()))) {
      throw new HTTPError(
        'Name already in use',
        { id, name: attributes.name },
        STATUS_CODES.unauthorized
      )
    }

    const collection = await Collection.findOne<CollectionAttributes>(id)

    if (collection) {
      if (await this.service.isPublished(collection.contract_address)) {
        throw new HTTPError(
          "The collection is published. It can't be saved",
          { id },
          STATUS_CODES.unauthorized
        )
      }

      if (this.service.isLockActive(collection.lock)) {
        throw new HTTPError(
          "The collection is locked. It can't be saved",
          { id },
          STATUS_CODES.locked
        )
      }
    }

    if (id !== attributes.id) {
      throw new HTTPError('The body and URL collection ids do not match', {
        urlId: id,
        bodyId: attributes.id,
      })
    }

    const factoryCollection = new FactoryCollection()
    attributes.salt = factoryCollection.getSalt(id)
    attributes.contract_address = factoryCollection.getContractAddress(
      attributes.salt,
      data
    )

    return new Collection(attributes).upsert()
  }

  deleteCollection = async (req: AuthRequest) => {
    const id = server.extractFromReq(req, 'id')

    const collection = (await Collection.findOne(id)) as CollectionAttributes // existance checked on middleware

    if (await this.service.isPublished(collection.contract_address)) {
      throw new HTTPError(
        "The collection is published. It can't be deleted",
        { id },
        STATUS_CODES.unauthorized
      )
    }

    if (this.service.isLockActive(collection.lock)) {
      throw new HTTPError(
        "The collection is locked. It can't be deleted",
        { id },
        STATUS_CODES.locked
      )
    }

    await Promise.all([
      Collection.delete({ id }),
      Item.delete({ collection_id: id }),
    ])
    return true
  }
}
