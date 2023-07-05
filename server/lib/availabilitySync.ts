import type { PlexMetadata } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import RadarrAPI from '@server/api/servarr/radarr';
import type { SonarrSeason } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import type Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

class AvailabilitySync {
  public running = false;
  private plexClient: PlexAPI;
  private plexSeasonsCache: Record<string, PlexMetadata[]> = {};
  private sonarrSeasonsCache: Record<string, SonarrSeason[]> = {};
  private radarrServers: RadarrSettings[];
  private sonarrServers: SonarrSettings[];

  async run() {
    const settings = getSettings();
    this.running = true;
    this.plexSeasonsCache = {};
    this.sonarrSeasonsCache = {};
    this.radarrServers = settings.radarr.filter((server) => server.syncEnabled);
    this.sonarrServers = settings.sonarr.filter((server) => server.syncEnabled);

    try {
      logger.info(`Starting availability sync...`, {
        label: 'AvailabilitySync',
      });
      const pageSize = 50;

      const userRepository = getRepository(User);
      const admin = await userRepository.findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });

      if (admin) {
        this.plexClient = new PlexAPI({ plexToken: admin.plexToken });
      } else {
        logger.error('An admin is not configured.');
      }

      for await (const media of this.loadAvailableMediaPaginated(pageSize)) {
        if (!this.running) {
          throw new Error('Job aborted');
        }

        // Check plex, radarr, and sonarr for that specific media and
        // if unavailable, then we change the status accordingly.
        // If a non-4k or 4k version exists in at least one of the instances, we will only update that specific version
        if (media.mediaType === 'movie') {
          let [movieExists, movieExists4k] = [false, false];
          const [existsInPlex, existsInPlex4k] = await this.mediaExistsInPlex(
            media
          );
          const [existsInRadarr, existsInRadarr4k] =
            await this.mediaExistsInRadarr(media);

          if (existsInPlex || existsInRadarr) {
            movieExists = true;
            logger.info(
              `The non-4K movie with TMDB ID ${media.tmdbId} still exists. Preventing removal.`,
              {
                label: 'AvailabilitySync',
              }
            );
          }

          if (existsInPlex4k || existsInRadarr4k) {
            movieExists4k = true;
            logger.info(
              `The 4K movie with TMDB ID ${media.tmdbId} still exists. Preventing removal.`,
              {
                label: 'AvailabilitySync',
              }
            );
          }

          if (
            (!movieExists && media.status === MediaStatus.AVAILABLE) ||
            (!movieExists4k && media.status4k === MediaStatus.AVAILABLE)
          ) {
            this.mediaUpdater(media, movieExists, movieExists4k);
          }
        }

        // If both versions still exist in plex, we still need
        // to check through sonarr to verify season availability
        if (media.mediaType === 'tv') {
          media.seasons.filter(
            (season) =>
              season.status === MediaStatus.AVAILABLE ||
              season.status === MediaStatus.PARTIALLY_AVAILABLE ||
              season.status4k === MediaStatus.AVAILABLE ||
              season.status4k === MediaStatus.PARTIALLY_AVAILABLE
          );

          let [showExists, showExists4k] = [false, false];
          const [
            existsInPlex,
            existsInPlex4k,
            existsInPlexMap,
            existsInPlexMap4k,
          ] = await this.mediaExistsInPlex(media);
          const [
            existsInSonarr,
            existsInSonarr4k,
            existsInSonarrMap,
            existsInSonarrMap4k,
          ] = await this.mediaExistsInSonarr(media);

          if (existsInPlex || existsInSonarr) {
            showExists = true;
            logger.info(
              `The non-4K show with TMDB ID ${media.tmdbId} still exists. Preventing removal.`,
              {
                label: 'AvailabilitySync',
              }
            );
          }

          if (existsInPlex4k || existsInSonarr4k) {
            showExists4k = true;
            logger.info(
              `The 4K show with TMDB ID ${media.tmdbId} still exists. Preventing removal.`,
              {
                label: 'AvailabilitySync',
              }
            );
          }

          const [seasonMap, seasonMap4k]: [
            Record<number, boolean>,
            Record<number, boolean>
          ] = [{}, {}];

          for (const season of media.seasons) {
            if (
              (existsInPlexMap && existsInPlexMap[season.seasonNumber]) ||
              existsInSonarrMap[season.seasonNumber]
            ) {
              seasonMap[season.seasonNumber] = true;
              logger.info(
                `The non-4K season ${season.seasonNumber} with TMDB ID ${media.tmdbId} still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            } else {
              seasonMap[season.seasonNumber] = false;
            }

            if (
              (existsInPlexMap4k && existsInPlexMap4k[season.seasonNumber]) ||
              existsInSonarrMap4k[season.seasonNumber]
            ) {
              seasonMap4k[season.seasonNumber] = true;
              logger.info(
                `The 4K season ${season.seasonNumber} with TMDB ID ${media.tmdbId} still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            } else {
              seasonMap4k[season.seasonNumber] = false;
            }

            if (
              (!seasonMap[season.seasonNumber] &&
                (season.status === MediaStatus.AVAILABLE ||
                  season.status === MediaStatus.PARTIALLY_AVAILABLE)) ||
              (!seasonMap4k[season.seasonNumber] &&
                (season.status === MediaStatus.AVAILABLE ||
                  season.status === MediaStatus.PARTIALLY_AVAILABLE))
            ) {
              await this.seasonUpdater(
                media,
                season,
                seasonMap[season.seasonNumber],
                seasonMap4k[season.seasonNumber]
              );
            }
          }

          if (
            (!showExists &&
              (media.status === MediaStatus.AVAILABLE ||
                media.status === MediaStatus.PARTIALLY_AVAILABLE)) ||
            (!showExists4k &&
              (media.status4k === MediaStatus.AVAILABLE ||
                media.status4k === MediaStatus.PARTIALLY_AVAILABLE))
          ) {
            this.mediaUpdater(media, showExists, showExists4k);
          }
        }
      }
    } catch (ex) {
      logger.error('Failed to complete availability sync.', {
        errorMessage: ex.message,
        label: 'AvailabilitySync',
      });
    } finally {
      logger.info(`Availability sync complete.`, {
        label: 'AvailabilitySync',
      });
      this.running = false;
    }
  }

  public cancel() {
    this.running = false;
  }

  private async *loadAvailableMediaPaginated(pageSize: number) {
    let offset = 0;
    const mediaRepository = getRepository(Media);
    const whereOptions = [
      { status: MediaStatus.AVAILABLE },
      { status: MediaStatus.PARTIALLY_AVAILABLE },
      { status4k: MediaStatus.AVAILABLE },
      { status4k: MediaStatus.PARTIALLY_AVAILABLE },
    ];

    let mediaPage: Media[];

    do {
      yield* (mediaPage = await mediaRepository.find({
        where: whereOptions,
        skip: offset,
        take: pageSize,
      }));
      offset += pageSize;
    } while (mediaPage.length > 0);
  }

  private findMediaStatus(
    requests: MediaRequest[],
    is4k?: boolean
  ): MediaStatus {
    const filteredRequests = requests.filter(
      (request) => request.is4k === is4k
    );

    let mediaStatus: MediaStatus;

    if (
      filteredRequests.some(
        (request) => request.status === MediaRequestStatus.APPROVED
      )
    ) {
      mediaStatus = MediaStatus.PROCESSING;
    } else if (
      filteredRequests.some(
        (request) => request.status === MediaRequestStatus.PENDING
      )
    ) {
      mediaStatus = MediaStatus.PENDING;
    } else {
      mediaStatus = MediaStatus.UNKNOWN;
    }

    return mediaStatus;
  }

  private async mediaUpdater(
    media: Media,
    mediaExists: boolean,
    mediaExists4k: boolean
  ): Promise<void> {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);

    try {
      // Find all related requests only if
      // the related media has an available status
      const requests = await requestRepository
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .where('(media.id = :id)', {
          id: media.id,
        })
        .andWhere(
          '((request.is4k = 0 AND media.status IN (:...mediaStatus)) OR (request.is4k = 1 AND media.status4k IN (:...mediaStatus)))',
          {
            mediaStatus: [
              MediaStatus.AVAILABLE,
              MediaStatus.PARTIALLY_AVAILABLE,
            ],
          }
        )
        .getMany();

      // Check if a season is processing or pending to
      // make sure we set the media to the correct status
      let [mediaStatus, mediaStatus4k] = [
        MediaStatus.UNKNOWN,
        MediaStatus.UNKNOWN,
      ];

      if (media.mediaType === 'tv') {
        if (!mediaExists) {
          mediaStatus = this.findMediaStatus(requests, false);
        }

        if (!mediaExists4k) {
          mediaStatus4k = this.findMediaStatus(requests, true);
        }
      }

      if (
        (media.status === MediaStatus.AVAILABLE ||
          media.status === MediaStatus.PARTIALLY_AVAILABLE) &&
        !mediaExists
      ) {
        (media.status = mediaStatus),
          (media.serviceId =
            mediaStatus === MediaStatus.PROCESSING ? media.serviceId : null),
          (media.externalServiceId =
            mediaStatus === MediaStatus.PROCESSING
              ? media.externalServiceId
              : null),
          (media.externalServiceSlug =
            mediaStatus === MediaStatus.PROCESSING
              ? media.externalServiceSlug
              : null),
          (media.ratingKey =
            mediaStatus === MediaStatus.PROCESSING ? media.ratingKey : null);
        logger.info(
          `The ${media.mediaType === 'tv' ? 'show' : 'movie'} with TMDB ID ${
            media.tmdbId
          } does not exist in your non-4K ${
            media.mediaType === 'tv' ? 'Sonarr' : 'Radarr'
          } and Plex instance. Status will be changed to unknown.`,
          { label: 'AvailabilitySync' }
        );
      }

      if (
        (media.status4k === MediaStatus.AVAILABLE ||
          media.status4k === MediaStatus.PARTIALLY_AVAILABLE) &&
        !mediaExists4k
      ) {
        (media.status4k = mediaStatus4k),
          (media.serviceId4k =
            mediaStatus === MediaStatus.PROCESSING ? media.serviceId4k : null),
          (media.externalServiceId4k =
            mediaStatus === MediaStatus.PROCESSING
              ? media.externalServiceId4k
              : null),
          (media.externalServiceSlug4k =
            mediaStatus === MediaStatus.PROCESSING
              ? media.externalServiceSlug4k
              : null),
          (media.ratingKey4k =
            mediaStatus === MediaStatus.PROCESSING ? media.ratingKey4k : null);
        logger.info(
          `The ${media.mediaType === 'tv' ? 'show' : 'movie'} with TMDB ID ${
            media.tmdbId
          } does not exist in your 4K ${
            media.mediaType === 'tv' ? 'Sonarr' : 'Radarr'
          } and Plex instance. Status will be changed to unknown.`,
          { label: 'AvailabilitySync' }
        );
      }

      await mediaRepository.save({ media, ...media });

      // Only delete media request if type is movie.
      // Type tv request deletion is handled
      // in the season request entity
      if (requests.length > 0 && media.mediaType === 'movie') {
        await requestRepository.remove(requests);
      }
    } catch (ex) {
      logger.debug(
        `Failure updating the ${
          media.mediaType === 'tv' ? 'show' : 'movie'
        } with TMDB ID ${media.tmdbId}.`,
        {
          errorMessage: ex.message,
          label: 'AvailabilitySync',
        }
      );
    }
  }

  private async seasonUpdater(
    media: Media,
    season: Season,
    seasonExists: boolean,
    seasonExists4k: boolean
  ): Promise<void> {
    const mediaRepository = getRepository(Media);
    const seasonRequestRepository = getRepository(SeasonRequest);

    try {
      const seasonRequests = await seasonRequestRepository.find({
        relations: {
          request: {
            media: {
              seasons: true,
            },
          },
        },
        where: {
          request: {
            media: {
              id: media.id,
            },
          },
          seasonNumber: season.seasonNumber,
        },
      });

      const filteredSeasonRequests = seasonRequests.filter(
        (seasonRequest) =>
          (!seasonRequest.request.is4k &&
            !seasonExists &&
            (season.status === MediaStatus.AVAILABLE ||
              season.status === MediaStatus.PARTIALLY_AVAILABLE)) ||
          (seasonRequest.request.is4k &&
            !seasonExists4k &&
            (season.status4k === MediaStatus.AVAILABLE ||
              season.status4k === MediaStatus.PARTIALLY_AVAILABLE))
      );

      let deletedSeason = false;

      // If season does not exist, we will change status to unknown and delete related season request
      // If parent media request is empty(all related seasons have been removed), parent is automatically deleted
      if (
        (season.status === MediaStatus.AVAILABLE ||
          season.status === MediaStatus.PARTIALLY_AVAILABLE) &&
        !seasonExists
      ) {
        season.status = MediaStatus.UNKNOWN;
        deletedSeason = true;
        logger.info(
          `Season ${season.seasonNumber}, TMDB ID ${media.tmdbId}, does not exist in your non-4K Sonarr and Plex instance. Status will be changed to unknown.`,
          { label: 'AvailabilitySync' }
        );
      }

      if (
        (season.status4k === MediaStatus.AVAILABLE ||
          season.status4k === MediaStatus.PARTIALLY_AVAILABLE) &&
        !seasonExists4k
      ) {
        season.status4k = MediaStatus.UNKNOWN;
        deletedSeason = true;
        logger.info(
          `Season ${season.seasonNumber}, TMDB ID ${media.tmdbId}, does not exist in your 4K Sonarr and Plex instance. Status will be changed to unknown.`,
          { label: 'AvailabilitySync' }
        );
      }

      if (!seasonExists && !seasonExists4k) {
        if (
          season.status === MediaStatus.AVAILABLE ||
          season.status === MediaStatus.PARTIALLY_AVAILABLE
        ) {
          season.status = MediaStatus.UNKNOWN;
          deletedSeason = true;
        }
        if (
          season.status4k === MediaStatus.AVAILABLE ||
          season.status4k === MediaStatus.PARTIALLY_AVAILABLE
        ) {
          season.status4k = MediaStatus.UNKNOWN;
          deletedSeason = true;
        }
      }

      if (deletedSeason) {
        media.seasons = [...media.seasons, season];
        await mediaRepository.save({ media, ...media });

        if (media.status === MediaStatus.AVAILABLE && !seasonExists) {
          await mediaRepository.update(media.id, {
            status: MediaStatus.PARTIALLY_AVAILABLE,
          });
          logger.info(
            `Marking the non-4K show with TMDB ID ${media.tmdbId} as PARTIALLY_AVAILABLE because season removal has occurred.`,
            { label: 'AvailabilitySync' }
          );
        }

        if (media.status4k === MediaStatus.AVAILABLE && !seasonExists4k) {
          await mediaRepository.update(media.id, {
            status4k: MediaStatus.PARTIALLY_AVAILABLE,
          });
          logger.info(
            `Marking the 4K show with TMDB ID ${media.tmdbId} as PARTIALLY_AVAILABLE because season removal has occurred.`,
            { label: 'AvailabilitySync' }
          );
        }

        if (filteredSeasonRequests.length > 0) {
          await seasonRequestRepository.remove(filteredSeasonRequests);
        }
      }
    } catch (ex) {
      logger.debug(
        `Failure updating ${season.seasonNumber}, TMDB ID ${media.tmdbId}.`,
        {
          errorMessage: ex.message,
          label: 'AvailabilitySync',
        }
      );
    }
  }

  private async mediaExistsInRadarr(media: Media): Promise<[boolean, boolean]> {
    let [existsInRadarr, existsInRadarr4k] = [false, false];

    // Check for availability in all of the available radarr servers
    // If any find the media, we will assume the media exists
    for (const server of this.radarrServers) {
      const radarrAPI = new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        if (!server.is4k && media.externalServiceId) {
          const radarr = await radarrAPI.getMovie({
            id: media.externalServiceId,
          });

          if (radarr && radarr.hasFile) {
            existsInRadarr = true;
          }
        }
      } catch (ex) {
        if (!ex.message.includes('404')) {
          existsInRadarr = true;
          logger.debug(
            `Failure retrieving the movie with TMDB ID ${media.tmdbId} from your non-4K Radarr.`,
            {
              errorMessage: ex.message,
              label: 'AvailabilitySync',
            }
          );
        }
      }

      try {
        if (server.is4k && media.externalServiceId4k) {
          const radarr4k = await radarrAPI.getMovie({
            id: media.externalServiceId4k,
          });

          if (radarr4k && radarr4k.hasFile) {
            existsInRadarr4k = true;
          }
        }
      } catch (ex) {
        if (!ex.message.includes('404')) {
          existsInRadarr4k = true;
          logger.debug(
            `Failure retrieving the movie with TMDB ID ${media.tmdbId} from your 4K Radarr.`,
            {
              errorMessage: ex.message,
              label: 'AvailabilitySync',
            }
          );
        }
      }
    }

    return [existsInRadarr, existsInRadarr4k];
  }

  private async mediaExistsInSonarr(
    media: Media
  ): Promise<
    [boolean, boolean, Record<number, boolean>, Record<number, boolean>]
  > {
    let [existsInSonarr, existsInSonarr4k] = [false, false];
    let [preventSeasonSearch, preventSeasonSearch4k] = [false, false];

    // Check for availability in all of the available sonarr servers
    // If any find the media, we will assume the media exists
    for (const server of this.sonarrServers) {
      const sonarrAPI = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        if (!server.is4k && media.externalServiceId) {
          const sonarr = await sonarrAPI.getSeriesById(media.externalServiceId);
          this.sonarrSeasonsCache[`0-${media.externalServiceId}`] =
            sonarr.seasons;

          if (sonarr && sonarr.statistics.episodeFileCount > 0) {
            existsInSonarr = true;
          }
        }
      } catch (ex) {
        if (!ex.message.includes('404')) {
          existsInSonarr = true;
          preventSeasonSearch = true;
          logger.debug(
            `Failure retrieving the show with TMDB ID ${media.tmdbId} from your non-4K Sonarr.`,
            {
              errorMessage: ex.message,
              label: 'AvailabilitySync',
            }
          );
        }
      }

      try {
        if (server.is4k && media.externalServiceId4k) {
          const sonarr4k = await sonarrAPI.getSeriesById(
            media.externalServiceId4k
          );
          this.sonarrSeasonsCache[`1-${media.externalServiceId4k}`] =
            sonarr4k.seasons;

          if (sonarr4k && sonarr4k.statistics.episodeFileCount > 0) {
            existsInSonarr4k = true;
          }
        }
      } catch (ex) {
        if (!ex.message.includes('404')) {
          existsInSonarr4k = true;
          preventSeasonSearch4k = true;
          logger.debug(
            `Failure retrieving the show with TMDB ID ${media.tmdbId} from your 4K Sonarr.`,
            {
              errorMessage: ex.message,
              label: 'AvailabilitySync',
            }
          );
        }
      }
    }

    const [sonarrSeasonMap, sonarrSeasonMap4k]: [
      Record<number, boolean>,
      Record<number, boolean>
    ] = [{}, {}];

    // Here we check each season for availability
    // If the API returns an error other than a 404,
    // we will have to prevent the season check from happening
    if (!preventSeasonSearch || !preventSeasonSearch4k) {
      for (const season of media.seasons) {
        [
          sonarrSeasonMap[season.seasonNumber],
          sonarrSeasonMap4k[season.seasonNumber],
        ] = await this.seasonExistsInSonarr(
          media,
          season,
          preventSeasonSearch,
          preventSeasonSearch4k
        );
      }
    }

    return [
      existsInSonarr,
      existsInSonarr4k,
      sonarrSeasonMap,
      sonarrSeasonMap4k,
    ];
  }

  private async seasonExistsInSonarr(
    media: Media,
    season: Season,
    preventSeasonSearch: boolean,
    preventSeasonSearch4k: boolean
  ): Promise<[boolean, boolean]> {
    let [seasonExists, seasonExists4k] = [false, false];

    // Check each sonarr instance to see if the media still exists
    // If found, we will assume the media exists and prevent removal
    // We can use the cache we built when we fetched the series with mediaExistsInSonarr
    if (
      media.externalServiceId &&
      (season.status === MediaStatus.AVAILABLE ||
        season.status === MediaStatus.PARTIALLY_AVAILABLE)
    ) {
      const sonarrSeasons =
        this.sonarrSeasonsCache[`0-${media.externalServiceId}`];

      const seasonIsAvailable = sonarrSeasons?.find(
        ({ seasonNumber, statistics }) =>
          season.seasonNumber === seasonNumber &&
          statistics?.episodeFileCount &&
          statistics?.episodeFileCount > 0
      );

      if ((seasonIsAvailable && sonarrSeasons) || preventSeasonSearch) {
        seasonExists = true;
      }
    }

    if (
      media.externalServiceId4k &&
      (season.status4k === MediaStatus.AVAILABLE ||
        season.status4k === MediaStatus.PARTIALLY_AVAILABLE)
    ) {
      const sonarrSeasons4k =
        this.sonarrSeasonsCache[`1-${media.externalServiceId4k}`];

      const seasonIsAvailable4k = sonarrSeasons4k?.find(
        ({ seasonNumber, statistics }) =>
          season.seasonNumber === seasonNumber &&
          statistics?.episodeFileCount &&
          statistics?.episodeFileCount > 0
      );

      if ((seasonIsAvailable4k && sonarrSeasons4k) || preventSeasonSearch4k) {
        seasonExists4k = true;
      }
    }

    return [seasonExists, seasonExists4k];
  }

  private async mediaExistsInPlex(
    media: Media
  ): Promise<
    [boolean, boolean, Record<number, boolean>?, Record<number, boolean>?]
  > {
    const [ratingKey, ratingKey4k] = [media.ratingKey, media.ratingKey4k];
    let [existsInPlex, existsInPlex4k] = [false, false];
    let [preventSeasonSearch, preventSeasonSearch4k] = [false, false];

    // Check each plex instance to see if the media still exists
    // If found, we will assume the media exists and prevent removal
    // We can use the cache we built when we fetched the series with mediaExistsInPlex
    try {
      if (ratingKey) {
        const plexMedia = await this.plexClient?.getMetadata(ratingKey);

        if (media.mediaType === 'tv') {
          this.plexSeasonsCache[ratingKey] =
            await this.plexClient?.getChildrenMetadata(ratingKey);
        }

        if (plexMedia) {
          existsInPlex = true;
        }
      }
    } catch (ex) {
      if (!ex.message.includes('404')) {
        existsInPlex = true;
        preventSeasonSearch = true;
        logger.debug(
          `Failure retrieving the ${
            media.mediaType === 'tv' ? 'show' : 'movie'
          } with TMDB ID ${media.tmdbId} from your non-4K Plex.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );
      }
    }

    try {
      if (ratingKey4k) {
        const plexMedia4k = await this.plexClient?.getMetadata(ratingKey4k);

        if (media.mediaType === 'tv') {
          this.plexSeasonsCache[ratingKey4k] =
            await this.plexClient?.getChildrenMetadata(ratingKey4k);
        }

        if (plexMedia4k) {
          existsInPlex4k = true;
        }
      }
    } catch (ex) {
      if (!ex.message.includes('404')) {
        existsInPlex4k = true;
        preventSeasonSearch4k = true;
        logger.debug(
          `Failure retrieving the ${
            media.mediaType === 'tv' ? 'show' : 'movie'
          } with TMDB ID ${media.tmdbId} from your 4K Plex.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );
      }
    }

    if (media.mediaType === 'movie') {
      return [existsInPlex, existsInPlex4k];
    }

    const [plexSeasonMap, plexSeasonMap4k]: [
      Record<number, boolean>,
      Record<number, boolean>
    ] = [{}, {}];

    // Here we check each season in plex for availability
    // If the API returns an error other than a 404,
    // we will have to prevent the season check from happening
    if (!preventSeasonSearch || !preventSeasonSearch4k) {
      for (const season of media.seasons) {
        [
          plexSeasonMap[season.seasonNumber],
          plexSeasonMap4k[season.seasonNumber],
        ] = await this.seasonExistsInPlex(
          media,
          season,
          preventSeasonSearch,
          preventSeasonSearch4k
        );
      }
    }

    return [existsInPlex, existsInPlex4k, plexSeasonMap, plexSeasonMap4k];
  }

  private async seasonExistsInPlex(
    media: Media,
    season: Season,
    preventSeasonSearch: boolean,
    preventSeasonSearch4k: boolean
  ): Promise<[boolean, boolean]> {
    const [ratingKey, ratingKey4k] = [media.ratingKey, media.ratingKey4k];
    let [seasonExistsInPlex, seasonExistsInPlex4k] = [false, false];

    // Check each plex instance to see if the season exists
    if (
      ratingKey &&
      (season.status === MediaStatus.AVAILABLE ||
        season.status === MediaStatus.PARTIALLY_AVAILABLE)
    ) {
      const children = this.plexSeasonsCache[ratingKey];
      const plexSeason = children?.find(
        (child) => child.index === season.seasonNumber
      );

      if (plexSeason || preventSeasonSearch) {
        seasonExistsInPlex = true;
      }
    }

    if (
      ratingKey4k &&
      (season.status4k === MediaStatus.AVAILABLE ||
        season.status4k === MediaStatus.PARTIALLY_AVAILABLE)
    ) {
      const children4k = this.plexSeasonsCache[ratingKey4k];
      const plexSeason4k = children4k?.find(
        (child) => child.index === season.seasonNumber
      );

      if (plexSeason4k || preventSeasonSearch4k) {
        seasonExistsInPlex4k = true;
      }
    }

    return [seasonExistsInPlex, seasonExistsInPlex4k];
  }
}

const availabilitySync = new AvailabilitySync();
export default availabilitySync;
