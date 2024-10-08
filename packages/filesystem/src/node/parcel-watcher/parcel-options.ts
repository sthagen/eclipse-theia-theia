// *****************************************************************************
// Copyright (C) 2017-2020 TypeFox and others.
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

import { Options } from '@theia/core/shared/@parcel/watcher';

/**
 * Inversify service identifier allowing extensions to override options passed to parcel by the file watcher.
 */
export const ParcelWatcherOptions = Symbol('ParcelWatcherOptions');
export type ParcelWatcherOptions = Options;
